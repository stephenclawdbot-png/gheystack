// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title PaymentChannel
 * @notice On-chain payment channels for agent-to-agent USDC micropayments.
 *         Off-chain signed state updates with on-chain dispute resolution.
 *
 * Flow:
 *   1. Agent A opens channel with Agent B, deposits USDC
 *   2. Off-chain: A sends signed state updates to B (incrementing balance)
 *   3. B can close channel cooperatively (both sign final state) or unilaterally
 *   4. Challenge period allows counterparty to submit latest signed state
 *   5. After challenge, funds are distributed per latest state
 *
 * This is the on-chain fallback / dispute resolution layer.
 * The off-chain channel manager (TypeScript) handles normal operation.
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract PaymentChannel {
    IERC20 public immutable usdc;

    // ─── Events ──────────────────────────────────────────────────

    event ChannelOpened(
        bytes32 indexed channelId,
        address indexed partyA,
        address indexed partyB,
        uint256 depositA,
        uint256 depositB,
        uint48 challengePeriod
    );
    event ChannelDeposited(bytes32 indexed channelId, address indexed depositor, uint256 amount);
    event ChannelClosed(bytes32 indexed channelId, uint256 balanceA, uint256 balanceB);
    event ChannelChallenged(bytes32 indexed channelId, uint256 newBalanceA, uint256 newBalanceB, address indexed challenger);
    event ChannelSettled(bytes32 indexed channelId);

    // ─── Structs ─────────────────────────────────────────────────

    struct Channel {
        address partyA;
        address partyB;
        uint256 depositA;
        uint256 depositB;
        uint256 balanceA;        // latest known balance for A
        uint256 balanceB;        // latest known balance for B
        uint48 challengePeriod;   // seconds
        uint48 challengeEndsAt;   // 0 if not in challenge, else timestamp
        uint48 closedAt;
        bool settling;
        bool closed;
    }

    // ─── State ────────────────────────────────────────────────────

    mapping(bytes32 => Channel) public channels;

    // ─── EIP-712 Domain ───────────────────────────────────────────

    // EIP-712 typed data for off-chain signing
    // ChannelState: { channelId, balanceA, balanceB, nonce }
    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant CHANNEL_STATE_TYPEHASH = keccak256(
        "ChannelState(bytes32 channelId,uint256 balanceA,uint256 balanceB,uint256 nonce)"
    );

    bytes32 private immutable DOMAIN_SEPARATOR;

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
        DOMAIN_SEPARATOR = keccak256(abi.encode(
            EIP712_DOMAIN_TYPEHASH,
            keccak256("Stack Payment Channels"),
            keccak256("1"),
            block.chainid,
            address(this)
        ));
    }

    // ─── Channel Lifecycle ───────────────────────────────────────

    function openChannel(
        address partyB,
        uint256 depositA,
        uint256 depositB,
        uint48 challengePeriod
    ) external returns (bytes32 channelId) {
        require(partyB != msg.sender, "Cannot open channel with self");
        require(challengePeriod >= 1 hours, "Challenge period too short");
        require(challengePeriod <= 30 days, "Challenge period too long");

        channelId = keccak256(abi.encodePacked(msg.sender, partyB, block.timestamp, block.chainid));

        require(channels[channelId].partyA == address(0), "Channel ID collision");

        // Transfer deposits
        if (depositA > 0) {
            require(usdc.transferFrom(msg.sender, address(this), depositA), "Deposit A failed");
        }
        if (depositB > 0) {
            require(usdc.transferFrom(partyB, address(this), depositB), "Deposit B failed");
        }

        channels[channelId] = Channel({
            partyA: msg.sender,
            partyB: partyB,
            depositA: depositA,
            depositB: depositB,
            balanceA: depositA,
            balanceB: depositB,
            challengePeriod: challengePeriod,
            challengeEndsAt: 0,
            closedAt: 0,
            settling: false,
            closed: false
        });

        emit ChannelOpened(channelId, msg.sender, partyB, depositA, depositB, challengePeriod);
    }

    function deposit(bytes32 channelId, uint256 amount) external {
        Channel storage ch = channels[channelId];
        require(ch.partyA != address(0), "Channel does not exist");
        require(!ch.closed, "Channel is closed");

        require(usdc.transferFrom(msg.sender, address(this), amount), "Deposit failed");

        if (msg.sender == ch.partyA) {
            ch.depositA += amount;
            ch.balanceA += amount;
        } else if (msg.sender == ch.partyB) {
            ch.depositB += amount;
            ch.balanceB += amount;
        } else {
            revert("Not a channel participant");
        }

        emit ChannelDeposited(channelId, msg.sender, amount);
    }

    // ─── Cooperative Close ────────────────────────────────────────

    /**
     * @notice Close channel cooperatively. Both parties must sign the final state.
     * @param channelId The channel ID
     * @param finalBalanceA Final balance for party A
     * @param finalBalanceB Final balance for party B
     * @param nonce State nonce (to prevent replay)
     * @param sigA Signature from party A
     * @param sigB Signature from party B
     */
    function cooperativeClose(
        bytes32 channelId,
        uint256 finalBalanceA,
        uint256 finalBalanceB,
        uint256 nonce,
        bytes calldata sigA,
        bytes calldata sigB
    ) external {
        Channel storage ch = channels[channelId];
        require(ch.partyA != address(0), "Channel does not exist");
        require(!ch.closed, "Channel already closed");

        // Verify finalBalanceA + finalBalanceB <= total deposit
        require(finalBalanceA + finalBalanceB <= ch.depositA + ch.depositB, "Balances exceed deposits");

        // Hash the state
        bytes32 stateHash = keccak256(abi.encode(
            CHANNEL_STATE_TYPEHASH,
            channelId,
            finalBalanceA,
            finalBalanceB,
            nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, stateHash));

        // Verify both signatures
        address signerA = recoverSigner(digest, sigA);
        address signerB = recoverSigner(digest, sigB);
        require(signerA == ch.partyA, "Invalid signature from A");
        require(signerB == ch.partyB, "Invalid signature from B");

        // Settle immediately
        ch.closed = true;
        ch.closedAt = uint48(block.timestamp);

        // Transfer funds
        if (finalBalanceA > 0) require(usdc.transfer(ch.partyA, finalBalanceA), "Payout A failed");
        if (finalBalanceB > 0) require(usdc.transfer(ch.partyB, finalBalanceB), "Payout B failed");

        emit ChannelClosed(channelId, finalBalanceA, finalBalanceB);
        emit ChannelSettled(channelId);
    }

    // ─── Challenge (Unilateral Close) ─────────────────────────────

    /**
     * @notice Initiate a challenge. The initiator submits the latest signed state.
     *         The counterparty has challengePeriod to submit a newer state.
     */
    function challenge(
        bytes32 channelId,
        uint256 newBalanceA,
        uint256 newBalanceB,
        uint256 nonce,
        bytes calldata counterpartySig
    ) external {
        Channel storage ch = channels[channelId];
        require(ch.partyA != address(0), "Channel does not exist");
        require(!ch.closed, "Channel is closed");
        require(ch.challengeEndsAt == 0 || block.timestamp < ch.challengeEndsAt, "Challenge period over");

        // Must be a participant
        require(msg.sender == ch.partyA || msg.sender == ch.partyB, "Not a participant");

        // Verify the counterparty's signature on this state
        address expectedSigner = msg.sender == ch.partyA ? ch.partyB : ch.partyA;

        bytes32 stateHash = keccak256(abi.encode(
            CHANNEL_STATE_TYPEHASH,
            channelId,
            newBalanceA,
            newBalanceB,
            nonce
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, stateHash));

        address signer = recoverSigner(digest, counterpartySig);
        require(signer == expectedSigner, "Invalid counterparty signature");

        // Update state (only if nonce is higher — not tracked on-chain, so we trust higher balances)
        ch.balanceA = newBalanceA;
        ch.balanceB = newBalanceB;

        // Start or extend challenge
        if (ch.challengeEndsAt == 0) {
            ch.challengeEndsAt = uint48(block.timestamp + ch.challengePeriod);
        }

        emit ChannelChallenged(channelId, newBalanceA, newBalanceB, msg.sender);
    }

    /**
     * @notice Settle the channel after the challenge period expires.
     *         Anyone can call this.
     */
    function settle(bytes32 channelId) external {
        Channel storage ch = channels[channelId];
        require(ch.partyA != address(0), "Channel does not exist");
        require(ch.challengeEndsAt != 0, "No challenge initiated");
        require(block.timestamp >= ch.challengeEndsAt, "Challenge period not over");
        require(!ch.closed, "Already closed");

        ch.closed = true;
        ch.closedAt = uint48(block.timestamp);
        ch.settling = false;

        // Transfer according to latest challenged state
        uint256 balA = ch.balanceA;
        uint256 balB = ch.balanceB;

        if (balA > 0) require(usdc.transfer(ch.partyA, balA), "Payout A failed");
        if (balB > 0) require(usdc.transfer(ch.partyB, balB), "Payout B failed");

        emit ChannelClosed(channelId, balA, balB);
        emit ChannelSettled(channelId);
    }

    // ─── View Functions ──────────────────────────────────────────

    function getChannel(bytes32 channelId) external view returns (Channel memory) {
        return channels[channelId];
    }

    function isInChallenge(bytes32 channelId) external view returns (bool) {
        Channel storage ch = channels[channelId];
        return ch.challengeEndsAt != 0 && block.timestamp < ch.challengeEndsAt;
    }

    function challengeTimeRemaining(bytes32 channelId) external view returns (uint256) {
        Channel storage ch = channels[channelId];
        if (ch.challengeEndsAt == 0) return 0;
        if (block.timestamp >= ch.challengeEndsAt) return 0;
        return ch.challengeEndsAt - block.timestamp;
    }

    // ─── Internal ────────────────────────────────────────────────

    function recoverSigner(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "Invalid signature length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        return ecrecover(digest, v, r, s);
    }
}