// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title StackMesh
 * @notice The unified on-chain contract for the Stack mesh protocol.
 *         Combines AgentRegistry, PaymentChannel, and AgentEscrow into
 *         a single deployed contract for gas efficiency.
 *
 * This is a factory + coordinator contract that manages:
 *   - Agent registration and reputation
 *   - Payment channel creation and settlement
 *   - Escrow creation and milestone release
 *   - Cross-contract coordination (e.g., escrow uses registry for verification)
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract StackMesh {
    IERC20 public immutable usdc;
    address public owner;

    // ─── Registry State ──────────────────────────────────────────

    struct AgentEntry {
        string did;
        uint256 stake;
        uint8 reputation;
        uint256 tasksCompleted;
        uint256 tasksFailed;
        uint256 totalEarnings;
        uint48 registeredAt;
        uint48 lastActiveAt;
        uint48 withdrawalInitiatedAt;
        bool active;
    }

    mapping(address => AgentEntry) public agents;
    mapping(address => mapping(bytes32 => bool)) public hasCapability;

    uint256 public minStake = 10e6;
    uint256 public withdrawalTimelock = 3 days;
    uint256 public constant MAX_REPUTATION = 100;
    uint256 public totalStaked;
    uint256 public totalAgents;

    // ─── Channel State ───────────────────────────────────────────

    struct Channel {
        address partyA;
        address partyB;
        uint256 depositA;
        uint256 depositB;
        uint256 balanceA;
        uint256 balanceB;
        uint48 challengePeriod;
        uint48 challengeEndsAt;
        bool closed;
    }

    mapping(bytes32 => Channel) public channels;

    // ─── Escrow State ────────────────────────────────────────────

    struct Milestone {
        string description;
        uint256 amount;
        bool released;
    }

    struct Escrow {
        address client;
        address agent;
        address arbitrator;
        uint256 totalAmount;
        uint256 releasedAmount;
        uint48 createdAt;
        uint48 deadline;
        uint8 nextMilestone;
        bool disputed;
        bool cancelled;
    }

    mapping(bytes32 => Escrow) public escrows;
    mapping(bytes32 => Milestone[]) public escrowMilestones;

    // ─── Events ──────────────────────────────────────────────────

    event AgentRegistered(address indexed agent, string did, uint256 stake);
    event StakeWithdrawn(address indexed agent, uint256 amount);
    event ReputationUpdated(address indexed agent, uint8 score, uint256 tasks);
    event AgentSlashed(address indexed agent, uint256 amount);

    event ChannelOpened(bytes32 indexed channelId, address partyA, address partyB, uint256 depositA);
    event ChannelSettled(bytes32 indexed channelId, uint256 balanceA, uint256 balanceB);

    event EscrowCreated(bytes32 indexed escrowId, address client, address agent, uint256 total);
    event MilestoneReleased(bytes32 indexed escrowId, uint256 index, uint256 amount);
    event EscrowResolved(bytes32 indexed escrowId, bool clientWins);

    // ─── Modifiers ───────────────────────────────────────────────

    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }
    modifier onlyActiveAgent() { require(agents[msg.sender].active, "Not active"); _; }

    mapping(address => bool) public arbitrators;

    // ─── Constructor ─────────────────────────────────────────────

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
        owner = msg.sender;
        arbitrators[msg.sender] = true;
    }

    // ═════════════════════════════════════════════════════════════════
    //                          AGENT REGISTRY
    // ═════════════════════════════════════════════════════════════════

    function register(
        string calldata did,
        uint256 stakeAmount,
        string[] calldata capabilities
    ) external {
        require(!agents[msg.sender].active, "Already registered");
        require(stakeAmount >= minStake, "Stake below minimum");

        require(usdc.transferFrom(msg.sender, address(this), stakeAmount), "Stake failed");

        for (uint i = 0; i < capabilities.length; i++) {
            hasCapability[msg.sender][keccak256(abi.encodePacked(capabilities[i]))] = true;
        }

        agents[msg.sender] = AgentEntry({
            did: did,
            stake: stakeAmount,
            reputation: 50,
            tasksCompleted: 0,
            tasksFailed: 0,
            totalEarnings: 0,
            registeredAt: uint48(block.timestamp),
            lastActiveAt: uint48(block.timestamp),
            withdrawalInitiatedAt: 0,
            active: true
        });

        totalAgents++;
        totalStaked += stakeAmount;
        emit AgentRegistered(msg.sender, did, stakeAmount);
    }

    function initiateWithdrawal() external onlyActiveAgent {
        agents[msg.sender].withdrawalInitiatedAt = uint48(block.timestamp);
    }

    function withdrawStake() external onlyActiveAgent {
        AgentEntry storage a = agents[msg.sender];
        require(a.withdrawalInitiatedAt != 0, "No pending withdrawal");
        require(block.timestamp >= a.withdrawalInitiatedAt + withdrawalTimelock, "Timelock active");

        uint256 amount = a.stake;
        a.stake = 0;
        a.active = false;
        a.withdrawalInitiatedAt = 0;
        totalStaked -= amount;
        totalAgents--;

        require(usdc.transfer(msg.sender, amount), "Withdrawal failed");
        emit StakeWithdrawn(msg.sender, amount);
    }

    function recordSuccess(address agent, uint256 earnings) external {
        require(arbitrators[msg.sender], "Not arbitrator");
        AgentEntry storage a = agents[agent];
        require(a.active, "Not active");

        a.tasksCompleted++;
        a.totalEarnings += earnings;
        a.lastActiveAt = uint48(block.timestamp);

        if (a.reputation < MAX_REPUTATION) {
            uint8 bump = a.reputation < 30 ? 3 : (a.reputation < 60 ? 2 : 1);
            a.reputation = a.reputation + bump > MAX_REPUTATION ? uint8(MAX_REPUTATION) : a.reputation + bump;
        }

        emit ReputationUpdated(agent, a.reputation, a.tasksCompleted);
    }

    function recordFailure(address agent) external {
        require(arbitrators[msg.sender], "Not arbitrator");
        AgentEntry storage a = agents[agent];
        a.tasksFailed++;
        a.lastActiveAt = uint48(block.timestamp);

        if (a.reputation > 0) {
            uint8 penalty = a.reputation > 70 ? 5 : (a.reputation > 40 ? 3 : 1);
            a.reputation = a.reputation > penalty ? a.reputation - penalty : 0;
        }

        emit ReputationUpdated(agent, a.reputation, a.tasksCompleted);
    }

    function slash(address agent, uint256 amount) external {
        require(arbitrators[msg.sender], "Not arbitrator");
        AgentEntry storage a = agents[agent];
        require(a.active && amount <= a.stake, "Invalid slash");

        a.stake -= amount;
        a.reputation = a.reputation > 20 ? a.reputation - 20 : 0;
        totalStaked -= amount;

        require(usdc.transfer(msg.sender, amount), "Slash failed");
        emit AgentSlashed(agent, amount);
    }

    function canAcceptTask(address agent, string calldata capability, uint8 minRep) external view returns (bool) {
        AgentEntry storage a = agents[agent];
        return a.active && a.reputation >= minRep && hasCapability[agent][keccak256(abi.encodePacked(capability))];
    }

    // ═════════════════════════════════════════════════════════════════
    //                        PAYMENT CHANNELS
    // ═════════════════════════════════════════════════════════════════

    function openChannel(
        address partyB,
        uint256 depositA,
        uint48 challengePeriod
    ) external onlyActiveAgent returns (bytes32 channelId) {
        require(partyB != msg.sender && challengePeriod >= 1 hours);

        channelId = keccak256(abi.encodePacked(msg.sender, partyB, block.timestamp));
        require(channels[channelId].partyA == address(0), "Collision");

        if (depositA > 0) require(usdc.transferFrom(msg.sender, address(this), depositA), "Deposit failed");

        channels[channelId] = Channel({
            partyA: msg.sender,
            partyB: partyB,
            depositA: depositA,
            depositB: 0,
            balanceA: depositA,
            balanceB: 0,
            challengePeriod: challengePeriod,
            challengeEndsAt: 0,
            closed: false
        });

        emit ChannelOpened(channelId, msg.sender, partyB, depositA);
    }

    function settleChannel(bytes32 channelId, uint256 balA, uint256 balB, bytes calldata sigA, bytes calldata sigB) external {
        Channel storage ch = channels[channelId];
        require(ch.partyA != address(0) && !ch.closed);

        // Simple settlement: both signatures required
        // In production, use EIP-712 like PaymentChannel.sol
        require(balA + balB <= ch.depositA + ch.depositB, "Exceeds deposits");

        // Verify signatures (simplified — see PaymentChannel.sol for EIP-712)
        bytes32 digest = keccak256(abi.encode(channelId, balA, balB));
        require(recoverSigner(digest, sigA) == ch.partyA, "Bad sig A");
        require(recoverSigner(digest, sigB) == ch.partyB, "Bad sig B");

        ch.closed = true;
        ch.balanceA = balA;
        ch.balanceB = balB;

        if (balA > 0) require(usdc.transfer(ch.partyA, balA), "Payout A failed");
        if (balB > 0) require(usdc.transfer(ch.partyB, balB), "Payout B failed");

        emit ChannelSettled(channelId, balA, balB);
    }

    // ═════════════════════════════════════════════════════════════════
    //                            ESCROW
    // ═════════════════════════════════════════════════════════════════

    function createEscrow(
        bytes32 escrowId,
        address agent,
        Milestone[] calldata _milestones,
        uint48 deadlineSeconds
    ) external {
        require(escrows[escrowId].client == address(0), "Exists");
        require(_milestones.length > 0 && _milestones.length <= 20);

        uint256 total = 0;
        for (uint i = 0; i < _milestones.length; i++) {
            require(_milestones[i].amount > 0);
            total += _milestones[i].amount;
            escrowMilestones[escrowId].push(_milestones[i]);
        }

        require(usdc.transferFrom(msg.sender, address(this), total), "Funding failed");

        escrows[escrowId] = Escrow({
            client: msg.sender,
            agent: agent,
            arbitrator: owner,
            totalAmount: total,
            releasedAmount: 0,
            createdAt: uint48(block.timestamp),
            deadline: uint48(block.timestamp + deadlineSeconds),
            nextMilestone: 0,
            disputed: false,
            cancelled: false
        });

        emit EscrowCreated(escrowId, msg.sender, agent, total);
    }

    function releaseMilestone(bytes32 escrowId) external {
        Escrow storage e = escrows[escrowId];
        require(e.client == msg.sender, "Not client");
        require(!e.disputed && !e.cancelled);
        require(e.nextMilestone < escrowMilestones[escrowId].length);

        Milestone storage m = escrowMilestones[escrowId][e.nextMilestone];
        require(!m.released);

        m.released = true;
        e.releasedAmount += m.amount;
        e.nextMilestone++;

        require(usdc.transfer(e.agent, m.amount), "Payment failed");
        emit MilestoneReleased(escrowId, e.nextMilestone - 1, m.amount);
    }

    function resolveDispute(bytes32 escrowId, bool clientWins) external {
        require(arbitrators[msg.sender], "Not arbitrator");
        Escrow storage e = escrows[escrowId];
        require(e.disputed, "No dispute");

        uint256 remaining = e.totalAmount - e.releasedAmount;
        address recipient = clientWins ? e.client : e.agent;

        if (remaining > 0) require(usdc.transfer(recipient, remaining), "Payout failed");

        emit EscrowResolved(escrowId, clientWins);
    }

    function refundExpired(bytes32 escrowId) external {
        Escrow storage e = escrows[escrowId];
        require(e.client == msg.sender, "Not client");
        require(!e.cancelled && !e.disputed);
        require(block.timestamp >= e.deadline, "Not expired");

        uint256 remaining = e.totalAmount - e.releasedAmount;
        e.cancelled = true;

        if (remaining > 0) require(usdc.transfer(e.client, remaining), "Refund failed");
    }

    // ─── Admin ───────────────────────────────────────────────────

    function addArbitrator(address addr) external onlyOwner {
        arbitrators[addr] = true;
    }

    function setMinStake(uint256 _min) external onlyOwner {
        minStake = _min;
    }

    // ─── Internal ────────────────────────────────────────────────

    function recoverSigner(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "Bad sig length");
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        return ecrecover(hash, v, r, s);
    }
}