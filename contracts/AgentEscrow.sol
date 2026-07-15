// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AgentEscrow
 * @notice Trustless USDC escrow for agent task payments with milestone support.
 *         Funds are locked until task completion, with arbiter dispute resolution.
 *
 * Flow:
 *   1. Client creates escrow with total amount + milestones
 *   2. Agent is assigned (either specific agent or open bidding)
 *   3. Agent submits results per milestone
 *   4. Client approves milestone → funds released
 *   5. If dispute: arbitrator resolves (approve or refund)
 *   6. Auto-expiry: if agent doesn't deliver, client can refund
 *   7. If client doesn't respond, agent can auto-release after timeout
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract AgentEscrow {
    IERC20 public immutable usdc;

    // ─── Events ──────────────────────────────────────────────────

    event EscrowCreated(
        bytes32 indexed escrowId,
        address indexed client,
        address indexed agent,
        uint256 totalAmount,
        uint48 deadline,
        Milestone[] milestones
    );
    event EscrowAssigned(bytes32 indexed escrowId, address indexed agent);
    event MilestoneSubmitted(bytes32 indexed escrowId, uint256 indexed index, bytes32 resultHash);
    event MilestoneReleased(bytes32 indexed escrowId, uint256 indexed index, uint256 amount, address indexed agent);
    event EscrowDisputed(bytes32 indexed escrowId, address indexed disputer);
    event EscrowResolved(bytes32 indexed escrowId, bool clientWins, address indexed arbitrator);
    event EscrowRefunded(bytes32 indexed escrowId, uint256 amount, address indexed client);
    event EscrowExpired(bytes32 indexed escrowId);

    // ─── Structs ─────────────────────────────────────────────────

    struct Milestone {
        string description;
        uint256 amount;
        bool released;
    }

    struct Escrow {
        address client;
        address agent;           // address(0) = unassigned (open bidding)
        address arbitrator;       // address(0) = default arbitrator
        uint256 totalAmount;
        uint256 releasedAmount;
        uint48 createdAt;
        uint48 deadline;          // task must be completed by this time
        uint48 disputeEndsAt;     // 0 if no active dispute
        uint8 nextMilestone;      // index of next milestone to submit
        bool disputed;
        bool resolved;
        bool cancelled;
    }

    // ─── State ───────────────────────────────────────────────────

    mapping(bytes32 => Escrow) public escrows;
    mapping(bytes32 => Milestone[]) public milestones;

    address public defaultArbitrator;
    uint48 public clientResponseTimeout = 7 days; // agent can auto-release if client doesn't respond
    uint48 public disputeResolutionTime = 3 days;
    address public owner;

    // ─── Modifiers ───────────────────────────────────────────────

    modifier onlyClient(bytes32 escrowId) {
        require(escrows[escrowId].client == msg.sender, "Not the client");
        _;
    }

    modifier onlyAgent(bytes32 escrowId) {
        require(escrows[escrowId].agent == msg.sender, "Not the agent");
        _;
    }

    // ─── Constructor ──────────────────────────────────────────────

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
        owner = msg.sender;
        defaultArbitrator = msg.sender;
    }

    // ─── Create Escrow ───────────────────────────────────────────

    /**
     * @notice Create a new escrow. USDC is locked immediately.
     * @param escrowId Unique ID (off-chain generated, e.g. hash of task details)
     * @param agent Agent address (address(0) for open assignment)
     * @param _milestones Array of milestone descriptions and amounts
     * @param deadlineSeconds Seconds from now until task deadline
     * @param arbitrator Custom arbitrator (address(0) for default)
     */
    function createEscrow(
        bytes32 escrowId,
        address agent,
        Milestone[] calldata _milestones,
        uint48 deadlineSeconds,
        address arbitrator
    ) external {
        require(escrows[escrowId].client == address(0), "Escrow ID already exists");
        require(_milestones.length > 0 && _milestones.length <= 20, "Invalid milestone count");
        require(deadlineSeconds >= 1 hours, "Deadline too short");

        // Calculate total
        uint256 total = 0;
        for (uint i = 0; i < _milestones.length; i++) {
            require(_milestones[i].amount > 0, "Milestone amount must be > 0");
            total += _milestones[i].amount;
        }
        require(total > 0, "Total must be > 0");

        // Transfer USDC from client
        require(usdc.transferFrom(msg.sender, address(this), total), "Funding failed");

        // Store milestones
        for (uint i = 0; i < _milestones.length; i++) {
            milestones[escrowId].push(_milestones[i]);
        }

        escrows[escrowId] = Escrow({
            client: msg.sender,
            agent: agent,
            arbitrator: arbitrator == address(0) ? defaultArbitrator : arbitrator,
            totalAmount: total,
            releasedAmount: 0,
            createdAt: uint48(block.timestamp),
            deadline: uint48(block.timestamp + deadlineSeconds),
            disputeEndsAt: 0,
            nextMilestone: 0,
            disputed: false,
            resolved: false,
            cancelled: false
        });

        emit EscrowCreated(escrowId, msg.sender, agent, total, uint48(block.timestamp + deadlineSeconds), _milestones);

        // Auto-assign if agent specified
        if (agent != address(0)) {
            emit EscrowAssigned(escrowId, agent);
        }
    }

    // ─── Assignment (for open escrows) ────────────────────────────

    function assignAgent(bytes32 escrowId, address agent) external {
        Escrow storage e = escrows[escrowId];
        require(e.client != address(0), "Escrow does not exist");
        require(e.agent == address(0), "Already assigned");
        require(msg.sender == e.client || msg.sender == defaultArbitrator, "Not authorized");
        require(!e.cancelled, "Escrow cancelled");

        e.agent = agent;
        emit EscrowAssigned(escrowId, agent);
    }

    // ─── Milestone Flow ──────────────────────────────────────────

    /**
     * @notice Agent submits result for the next milestone.
     *         This is an off-chain reference; the actual result is stored off-chain.
     * @param resultHash Hash of the result data (IPFS hash, etc.)
     */
    function submitMilestone(bytes32 escrowId, bytes32 resultHash) external onlyAgent(escrowId) {
        Escrow storage e = escrows[escrowId];
        require(!e.disputed && !e.cancelled, "Escrow not active");
        require(e.nextMilestone < milestones[escrowId].length, "All milestones submitted");
        require(block.timestamp < e.deadline, "Deadline passed");

        emit MilestoneSubmitted(escrowId, e.nextMilestone, resultHash);
        // Client must now approve (call releaseMilestone)
    }

    /**
     * @notice Client approves a milestone and releases payment to agent.
     */
    function releaseMilestone(bytes32 escrowId) external onlyClient(escrowId) {
        Escrow storage e = escrows[escrowId];
        require(!e.disputed && !e.cancelled, "Escrow not active");
        require(e.nextMilestone < milestones[escrowId].length, "All milestones released");

        Milestone storage m = milestones[escrowId][e.nextMilestone];
        require(!m.released, "Already released");

        m.released = true;
        e.releasedAmount += m.amount;
        e.nextMilestone++;

        require(usdc.transfer(e.agent, m.amount), "Payment failed");

        emit MilestoneReleased(escrowId, e.nextMilestone - 1, m.amount, e.agent);
    }

    /**
     * @notice Agent can auto-release milestone if client doesn't respond.
     *         Requires clientResponseTimeout to have passed since submission.
     * @param submittedAt Timestamp when milestone was submitted (off-chain proof).
     *         In production, this would use an on-chain submission timestamp.
     */
    function autoReleaseMilestone(bytes32 escrowId, uint48 submittedAt) external onlyAgent(escrowId) {
        Escrow storage e = escrows[escrowId];
        require(!e.disputed && !e.cancelled, "Escrow not active");
        require(e.nextMilestone < milestones[escrowId].length, "All milestones released");
        require(
            block.timestamp >= submittedAt + clientResponseTimeout,
            "Client response timeout not reached"
        );

        Milestone storage m = milestones[escrowId][e.nextMilestone];
        require(!m.released, "Already released");

        m.released = true;
        e.releasedAmount += m.amount;
        e.nextMilestone++;

        require(usdc.transfer(e.agent, m.amount), "Auto-payment failed");

        emit MilestoneReleased(escrowId, e.nextMilestone - 1, m.amount, e.agent);
    }

    // ─── Dispute Resolution ──────────────────────────────────────

    /**
     * @notice Either party can open a dispute.
     */
    function openDispute(bytes32 escrowId) external {
        Escrow storage e = escrows[escrowId];
        require(e.client == msg.sender || e.agent == msg.sender, "Not a participant");
        require(!e.disputed, "Already disputed");
        require(!e.cancelled, "Escrow cancelled");

        e.disputed = true;
        e.disputeEndsAt = uint48(block.timestamp + disputeResolutionTime);

        emit EscrowDisputed(escrowId, msg.sender);
    }

    /**
     * @notice Arbitrator resolves dispute.
     * @param clientWins If true, remaining funds go to client. If false, to agent.
     */
    function resolveDispute(bytes32 escrowId, bool clientWins) external {
        Escrow storage e = escrows[escrowId];
        require(e.disputed, "No dispute");
        require(!e.resolved, "Already resolved");
        require(msg.sender == e.arbitrator || msg.sender == defaultArbitrator, "Not arbitrator");

        e.resolved = true;

        uint256 remaining = e.totalAmount - e.releasedAmount;

        if (clientWins) {
            // Refund remaining to client
            if (remaining > 0) require(usdc.transfer(e.client, remaining), "Refund failed");
        } else {
            // Pay remaining to agent
            if (remaining > 0) require(usdc.transfer(e.agent, remaining), "Payment failed");
            e.releasedAmount = e.totalAmount;
        }

        emit EscrowResolved(escrowId, clientWins, msg.sender);
    }

    // ─── Expiry / Refund ─────────────────────────────────────────

    /**
     * @notice If the deadline passes and the agent hasn't completed all milestones,
     *         the client can claim a refund of unreleased funds.
     */
    function refundExpired(bytes32 escrowId) external onlyClient(escrowId) {
        Escrow storage e = escrows[escrowId];
        require(!e.cancelled, "Already cancelled");
        require(!e.disputed, "Escrow disputed");
        require(block.timestamp >= e.deadline, "Deadline not passed");
        require(e.releasedAmount < e.totalAmount, "All funds released");

        uint256 remaining = e.totalAmount - e.releasedAmount;
        e.cancelled = true;

        require(usdc.transfer(e.client, remaining), "Refund failed");

        emit EscrowRefunded(escrowId, remaining, e.client);
        emit EscrowExpired(escrowId);
    }

    /**
     * @notice Client cancels an unassigned escrow (before agent assignment).
     */
    function cancelUnassigned(bytes32 escrowId) external onlyClient(escrowId) {
        Escrow storage e = escrows[escrowId];
        require(e.agent == address(0), "Agent already assigned");
        require(!e.cancelled, "Already cancelled");

        e.cancelled = true;
        require(usdc.transfer(e.client, e.totalAmount), "Refund failed");

        emit EscrowRefunded(escrowId, e.totalAmount, e.client);
    }

    // ─── View Functions ──────────────────────────────────────────

    function getEscrow(bytes32 escrowId) external view returns (Escrow memory) {
        return escrows[escrowId];
    }

    function getMilestones(bytes32 escrowId) external view returns (Milestone[] memory) {
        return milestones[escrowId];
    }

    function getMilestoneCount(bytes32 escrowId) external view returns (uint256) {
        return milestones[escrowId].length;
    }

    function getRemainingBalance(bytes32 escrowId) external view returns (uint256) {
        return escrows[escrowId].totalAmount - escrows[escrowId].releasedAmount;
    }

    function isFullyReleased(bytes32 escrowId) external view returns (bool) {
        return escrows[escrowId].releasedAmount >= escrows[escrowId].totalAmount;
    }

    // ─── Admin ───────────────────────────────────────────────────

    function setDefaultArbitrator(address _addr) external {
        require(msg.sender == owner, "Not owner");
        defaultArbitrator = _addr;
    }

    function setDisputeResolutionTime(uint48 _time) external {
        require(msg.sender == owner, "Not owner");
        disputeResolutionTime = _time;
    }

    function setClientResponseTimeout(uint48 _time) external {
        require(msg.sender == owner, "Not owner");
        clientResponseTimeout = _time;
    }

    function transferOwnership(address _newOwner) external {
        require(msg.sender == owner, "Not owner");
        owner = _newOwner;
    }
}