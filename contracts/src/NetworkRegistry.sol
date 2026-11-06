// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IVault} from "./interfaces/IPalm.sol";

interface IHubVotes {
    function extendFreeze(address vault, uint64 until) external;
    function applyWorkflowRotation() external;
    function isVault(address) external view returns (bool);
    function statusOf(address) external view returns (uint8);
}

interface ISafetyFund {
    function payout(address token, address to, uint256 amount) external;
}

/// Members, the network Blocklist and Votes (ADR-0004).
/// A Vote can only: extend a Freeze, migrate a Vault to its own Recovery vault, remove a Blocklist entry,
/// release a SafetyFund payout to the affected Member's own Recovery vault, or apply a timelocked workflow
/// rotation. No action takes a destination address, so colluding Members can delay money or send it home,
/// never take it.
contract NetworkRegistry {
    uint8 public constant ACTION_EXTEND_FREEZE = 1;
    uint8 public constant ACTION_MIGRATE = 2;
    uint8 public constant ACTION_UNBLOCK = 3;
    uint8 public constant ACTION_SAFETY_PAYOUT = 4;
    uint8 public constant ACTION_ROTATE_WORKFLOW = 5;

    uint256 public constant VOTE_DELAY = 7 days; // new Members can't vote for 7 days
    uint256 public constant BLOCKLIST_TTL = 30 days;
    uint256 public constant FREEZE_EXTENSION = 7 days;

    struct Member {
        address vault;
        uint64 admittedAt;
        bool active;
    }

    struct Proposal {
        uint8 action;
        address target; // vault (freeze/migrate/payout) or blocklisted account (unblock); 0 for rotation
        address token; // payout only
        uint256 amount; // payout only
        address affected; // the affected Member (excluded from the electorate)
        uint64 start;
        uint64 end;
        uint32 eligible;
        uint32 yes;
        bool executed;
    }

    address public immutable admin;
    IHubVotes public immutable hub;
    uint256 public immutable voteWindow; // 24h production, 5 min demo
    address public factory;
    address public safetyFund;

    mapping(address => Member) public members; // voting key => member
    mapping(address => address) public memberOfVault; // vault => voting key
    address[] internal _memberList;
    mapping(address => uint64) public blockedUntil;
    mapping(address => address) public blockedBy;

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    event MemberAdmitted(address indexed member, address indexed vault, uint64 admittedAt);
    event Blocklisted(address indexed account, address indexed sourceVault, uint64 until);
    event Unblocked(address indexed account);
    event Proposed(uint256 indexed id, uint8 action, address target, address affected, uint64 end, uint32 eligible);
    event Voted(uint256 indexed id, address indexed member, uint32 yes);
    event Executed(uint256 indexed id);

    error NotAdmin();
    error NotHub();
    error NotFactory();
    error AlreadySet();
    error NotEligible();
    error AlreadyVoted();
    error Closed();
    error NotPassed();
    error BadAction();

    constructor(address admin_, address hub_, uint256 voteWindow_) {
        admin = admin_;
        hub = IHubVotes(hub_);
        voteWindow = voteWindow_;
    }

    function setWiring(address factory_, address safetyFund_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (factory != address(0)) revert AlreadySet();
        factory = factory_;
        safetyFund = safetyFund_;
    }

    // --- Members (admitted by the palmfi admin through Institution onboarding) ---

    function admit(address member, address vault) external {
        if (msg.sender != factory) revert NotFactory();
        members[member] = Member(vault, uint64(block.timestamp), true);
        memberOfVault[vault] = member;
        _memberList.push(member);
        emit MemberAdmitted(member, vault, uint64(block.timestamp));
    }

    function memberList() external view returns (address[] memory) {
        return _memberList;
    }

    function canVote(address member, uint256 at) public view returns (bool) {
        Member memory m = members[member];
        return m.active && m.admittedAt + VOTE_DELAY <= at;
    }

    // --- Blocklist ---

    function isBlocked(address account) external view returns (bool) {
        return blockedUntil[account] > block.timestamp;
    }

    function addToBlocklist(address account, address sourceVault) external {
        if (msg.sender != address(hub)) revert NotHub();
        if (account == address(0) || hub.isVault(account)) return;
        uint64 until = uint64(block.timestamp + BLOCKLIST_TTL);
        blockedUntil[account] = until;
        blockedBy[account] = sourceVault;
        emit Blocklisted(account, sourceVault, until);
    }

    // --- Votes ---

    function propose(uint8 action, address target, address token, uint256 amount) external returns (uint256 id) {
        if (!members[msg.sender].active) revert NotEligible();
        address affected;
        if (action == ACTION_EXTEND_FREEZE || action == ACTION_MIGRATE || action == ACTION_SAFETY_PAYOUT) {
            if (!hub.isVault(target)) revert BadAction();
            affected = memberOfVault[target];
            if (action == ACTION_SAFETY_PAYOUT && affected == address(0)) revert BadAction(); // Members only
        } else if (action == ACTION_UNBLOCK) {
            affected = address(0);
        } else if (action == ACTION_ROTATE_WORKFLOW) {
            target = address(0);
        } else {
            revert BadAction();
        }
        if (action != ACTION_SAFETY_PAYOUT) {
            token = address(0);
            amount = 0;
        }
        uint32 eligible;
        for (uint256 i; i < _memberList.length; i++) {
            address m = _memberList[i];
            if (m != affected && canVote(m, block.timestamp)) eligible++;
        }
        id = ++proposalCount;
        uint64 end = uint64(block.timestamp + voteWindow);
        proposals[id] =
            Proposal(action, target, token, amount, affected, uint64(block.timestamp), end, eligible, 0, false);
        emit Proposed(id, action, target, affected, end, eligible);
    }

    function vote(uint256 id) external {
        Proposal storage p = proposals[id];
        if (p.start == 0 || block.timestamp > p.end || p.executed) revert Closed();
        if (msg.sender == p.affected || !canVote(msg.sender, p.start)) revert NotEligible();
        if (hasVoted[id][msg.sender]) revert AlreadyVoted();
        hasVoted[id][msg.sender] = true;
        p.yes++;
        emit Voted(id, msg.sender, p.yes);
    }

    function passed(uint256 id) public view returns (bool) {
        Proposal storage p = proposals[id];
        return p.eligible > 0 && uint256(p.yes) * 2 > p.eligible;
    }

    /// Anyone can execute a passed Vote.
    function execute(uint256 id) external {
        Proposal storage p = proposals[id];
        if (p.executed) revert Closed();
        if (!passed(id)) revert NotPassed();
        p.executed = true;
        if (p.action == ACTION_EXTEND_FREEZE) {
            hub.extendFreeze(p.target, uint64(block.timestamp + FREEZE_EXTENSION));
        } else if (p.action == ACTION_MIGRATE) {
            IVault(p.target).voteMigrate();
        } else if (p.action == ACTION_UNBLOCK) {
            delete blockedUntil[p.target];
            emit Unblocked(p.target);
        } else if (p.action == ACTION_SAFETY_PAYOUT) {
            ISafetyFund(safetyFund).payout(p.token, IVault(p.target).recoveryVault(), p.amount);
        } else {
            hub.applyWorkflowRotation();
        }
        emit Executed(id);
    }
}
