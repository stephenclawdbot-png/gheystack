// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title AgentRegistry
 * @notice On-chain registry for AI agents in the Stack mesh protocol.
 *         Agents stake USDC to join, earn reputation for completed tasks,
 *         and can be slashed for malicious behavior.
 *
 * Features:
 *   - Register with stake (USDC)
 *   - Stake is slashable (dispute resolution, verified misbehavior)
 *   - Non-transferable reputation scores (soulbound-style)
 *   - Capability tagging (string-keyed)
 *   - Slashing with evidence requirement
 *   - Withdrawal with timelock (prevents rage-quit after bad behavior)
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract AgentRegistry {
    IERC20 public immutable usdc;

    // ─── Events ──────────────────────────────────────────────────

    event AgentRegistered(address indexed agent, string did, uint256 stake, string[] capabilities);
    event StakeIncreased(address indexed agent, uint256 amount, uint256 newTotal);
    event StakeWithdrawn(address indexed agent, uint256 amount, uint256 remaining);
    event ReputationUpdated(address indexed agent, uint8 newScore, uint256 totalTasks);
    event AgentSlashed(address indexed agent, uint256 amount, address indexed arbitrator, bytes32 evidenceHash);
    event WithdrawalInitiated(address indexed agent, uint256 unlockTime);
    event CapabilityAdded(address indexed agent, string capability);
    event CapabilityRemoved(address indexed agent, string capability);

    // ─── Structs ─────────────────────────────────────────────────

    struct AgentEntry {
        string did;
        uint256 stake;
        uint8 reputation;       // 0-100
        uint256 tasksCompleted;
        uint256 tasksFailed;
        uint256 totalEarnings;  // lifetime USDC earned (in 6-decimal units)
        uint48 registeredAt;
        uint48 lastActiveAt;
        uint48 withdrawalInitiatedAt; // 0 if no pending withdrawal
        bool active;
        bytes32[] capabilities; // hashed capability keys
    }

    // ─── State ───────────────────────────────────────────────────

    mapping(address => AgentEntry) public agents;
    mapping(address => mapping(bytes32 => bool)) public hasCapability;

    uint256 public minStake = 10e6;         // 10 USDC minimum
    uint256 public withdrawalTimelock = 3 days;
    uint8 public slashPercentage = 50;       // slash 50% of stake by default
    uint256 public constant MAX_REPUTATION = 100;

    address public owner;
    mapping(address => bool) public arbitrators; // trusted slashers

    uint256 public totalAgents;
    uint256 public totalStaked;

    // ─── Modifiers ───────────────────────────────────────────────

    modifier onlyActiveAgent() {
        require(agents[msg.sender].active, "Not a registered agent");
        _;
    }

    modifier onlyArbitrator() {
        require(arbitrators[msg.sender], "Not an arbitrator");
        _;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    // ─── Constructor ─────────────────────────────────────────────

    constructor(address _usdc) {
        usdc = IERC20(_usdc);
        owner = msg.sender;
        arbitrators[msg.sender] = true;
    }

    // ─── Registration ─────────────────────────────────────────────

    function register(
        string calldata did,
        uint256 stakeAmount,
        string[] calldata capabilities
    ) external {
        require(!agents[msg.sender].active, "Already registered");
        require(stakeAmount >= minStake, "Stake below minimum");
        require(bytes(did).length > 0, "DID required");

        // Transfer USDC stake from agent
        require(usdc.transferFrom(msg.sender, address(this), stakeAmount), "Stake transfer failed");

        // Hash capabilities for storage efficiency
        bytes32[] memory capHashes = new bytes32[](capabilities.length);
        for (uint i = 0; i < capabilities.length; i++) {
            capHashes[i] = keccak256(abi.encodePacked(capabilities[i]));
            hasCapability[msg.sender][capHashes[i]] = true;
        }

        agents[msg.sender] = AgentEntry({
            did: did,
            stake: stakeAmount,
            reputation: 50, // start at neutral reputation
            tasksCompleted: 0,
            tasksFailed: 0,
            totalEarnings: 0,
            registeredAt: uint48(block.timestamp),
            lastActiveAt: uint48(block.timestamp),
            withdrawalInitiatedAt: 0,
            active: true,
            capabilities: capHashes
        });

        totalAgents++;
        totalStaked += stakeAmount;

        emit AgentRegistered(msg.sender, did, stakeAmount, capabilities);
    }

    function increaseStake(uint256 amount) external onlyActiveAgent {
        require(amount > 0, "Amount must be > 0");
        require(usdc.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        agents[msg.sender].stake += amount;
        totalStaked += amount;
        emit StakeIncreased(msg.sender, amount, agents[msg.sender].stake);
    }

    // ─── Withdrawal ───────────────────────────────────────────────

    function initiateWithdrawal() external onlyActiveAgent {
        AgentEntry storage agent = agents[msg.sender];
        require(agent.withdrawalInitiatedAt == 0, "Withdrawal already initiated");
        agent.withdrawalInitiatedAt = uint48(block.timestamp);
        emit WithdrawalInitiated(msg.sender, block.timestamp + withdrawalTimelock);
    }

    function withdrawStake() external onlyActiveAgent {
        AgentEntry storage agent = agents[msg.sender];
        require(agent.withdrawalInitiatedAt != 0, "No pending withdrawal");
        require(
            block.timestamp >= agent.withdrawalInitiatedAt + withdrawalTimelock,
            "Timelock not expired"
        );

        uint256 amount = agent.stake;
        agent.stake = 0;
        agent.active = false;
        agent.withdrawalInitiatedAt = 0;

        totalStaked -= amount;
        totalAgents--;

        require(usdc.transfer(msg.sender, amount), "Withdrawal failed");
        emit StakeWithdrawn(msg.sender, amount, 0);
    }

    function cancelWithdrawal() external onlyActiveAgent {
        agents[msg.sender].withdrawalInitiatedAt = 0;
    }

    // ─── Reputation ──────────────────────────────────────────────

    function recordTaskSuccess(address agent, uint256 earnings) external onlyArbitrator {
        AgentEntry storage a = agents[agent];
        require(a.active, "Agent not active");

        a.tasksCompleted++;
        a.totalEarnings += earnings;
        a.lastActiveAt = uint48(block.timestamp);

        // Reputation increases, capped at 100
        if (a.reputation < MAX_REPUTATION) {
            uint8 bump = 1;
            if (a.reputation < 30) bump = 3;
            else if (a.reputation < 60) bump = 2;
            a.reputation = a.reputation + bump > MAX_REPUTATION ? uint8(MAX_REPUTATION) : a.reputation + bump;
        }

        emit ReputationUpdated(agent, a.reputation, a.tasksCompleted);
    }

    function recordTaskFailure(address agent) external onlyArbitrator {
        AgentEntry storage a = agents[agent];
        require(a.active, "Agent not active");

        a.tasksFailed++;
        a.lastActiveAt = uint48(block.timestamp);

        // Reputation decreases, floored at 0
        if (a.reputation > 0) {
            uint8 penalty = a.reputation > 70 ? 5 : (a.reputation > 40 ? 3 : 1);
            a.reputation = a.reputation > penalty ? a.reputation - penalty : 0;
        }

        emit ReputationUpdated(agent, a.reputation, a.tasksCompleted);
    }

    // ─── Slashing ─────────────────────────────────────────────────

    function slash(address agent, uint256 amount, bytes32 evidenceHash) external onlyArbitrator {
        AgentEntry storage a = agents[agent];
        require(a.active, "Agent not active");
        require(amount > 0 && amount <= a.stake, "Invalid slash amount");

        a.stake -= amount;
        totalStaked -= amount;

        // Also slash reputation
        a.reputation = a.reputation > 20 ? a.reputation - 20 : 0;

        // Slashed funds go to arbitrator (incentive for honest slashing)
        require(usdc.transfer(msg.sender, amount), "Slash transfer failed");

        emit AgentSlashed(agent, amount, msg.sender, evidenceHash);
    }

    // ─── Capabilities ────────────────────────────────────────────

    function addCapability(string calldata capability) external onlyActiveAgent {
        bytes32 capHash = keccak256(abi.encodePacked(capability));
        require(!hasCapability[msg.sender][capHash], "Already has capability");
        hasCapability[msg.sender][capHash] = true;
        agents[msg.sender].capabilities.push(capHash);
        emit CapabilityAdded(msg.sender, capability);
    }

    function removeCapability(string calldata capability) external onlyActiveAgent {
        bytes32 capHash = keccak256(abi.encodePacked(capability));
        require(hasCapability[msg.sender][capHash], "Does not have capability");
        hasCapability[msg.sender][capHash] = false;
        emit CapabilityRemoved(msg.sender, capability);
    }

    // ─── View Functions ───────────────────────────────────────────

    function getAgent(address agent) external view returns (AgentEntry memory) {
        return agents[agent];
    }

    function getReputation(address agent) external view returns (uint8) {
        return agents[agent].reputation;
    }

    function getStake(address agent) external view returns (uint256) {
        return agents[agent].stake;
    }

    function hasCap(address agent, string calldata capability) external view returns (bool) {
        return hasCapability[agent][keccak256(abi.encodePacked(capability))];
    }

    function canAcceptTask(address agent, string calldata capability, uint256 minRep) external view returns (bool) {
        AgentEntry storage a = agents[agent];
        return a.active && a.reputation >= minRep && hasCapability[agent][keccak256(abi.encodePacked(capability))];
    }

    // ─── Admin ────────────────────────────────────────────────────

    function setMinStake(uint256 _minStake) external onlyOwner {
        minStake = _minStake;
    }

    function setWithdrawalTimelock(uint48 _timelock) external onlyOwner {
        withdrawalTimelock = _timelock;
    }

    function setSlashPercentage(uint8 _pct) external onlyOwner {
        require(_pct <= 100, "Invalid percentage");
        slashPercentage = _pct;
    }

    function addArbitrator(address _addr) external onlyOwner {
        arbitrators[_addr] = true;
    }

    function removeArbitrator(address _addr) external onlyOwner {
        arbitrators[_addr] = false;
    }

    function transferOwnership(address _newOwner) external onlyOwner {
        owner = _newOwner;
    }
}