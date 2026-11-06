// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PalmTypes as T} from "./libraries/PalmTypes.sol";
import {ProtectedToken} from "./tokens/ProtectedToken.sol";
import {VaultBase} from "./VaultBase.sol";

/// Settings changes by majority vote (instant tightening by any one wallet, timelocked loosening), recovery, and the
/// Sentinel/Reconciler views. Runs only via delegatecall from a Vault (same storage layout through VaultBase), so the
/// Vault stays under EIP-170.
contract VaultModule is VaultBase {
    // ------------------------------------------------------------------
    // Tightening: instant, any one wallet
    // ------------------------------------------------------------------

    function lowerBudget(uint128 b24, uint128 b7) external onlyWallet {
        if (b24 > budget24h || b7 > budget7d) revert NotTightening();
        budget24h = b24;
        budget7d = b7;
    }

    function tightenLimits(uint128 cap, uint32 floor_, uint32 max_, uint32 capDelay_) external onlyWallet {
        if (cap > hardCap || floor_ < floorDelay || max_ < maxDelay || capDelay_ < capDelay) revert NotTightening();
        _checkLimits(floor_, max_, capDelay_);
        hardCap = cap;
        floorDelay = floor_;
        maxDelay = max_;
        capDelay = capDelay_;
    }

    function removeDestination(address d) external onlyWallet {
        isDestination[d] = false;
    }

    function removeDelegate(address d) external onlyWallet {
        isApprovedDelegate[d] = false;
    }

    /// A wallet can always leave (e.g. its key is suspect), as long as the Vault keeps MIN_WALLETS.
    function leave() external {
        if (!isWallet[msg.sender]) revert NotWallet();
        _removeWallet(msg.sender);
    }

    // ------------------------------------------------------------------
    // Changes: any wallet proposes, a majority of the snapshot passes, the timelock runs, anyone executes
    // ------------------------------------------------------------------

    function proposeChange(uint8 kind, bytes calldata data) external onlyWallet returns (uint256 id) {
        if (kind < T.CHANGE_ADD_WALLET || kind > T.CHANGE_MIGRATE) revert BadKind();
        if (kind == T.CHANGE_ADD_WALLET) {
            abi.decode(data, (address));
            pendingWalletAdds++;
        } else if (kind == T.CHANGE_LIMITS) {
            (, uint32 f, uint32 m, uint32 cd) = abi.decode(data, (uint128, uint32, uint32, uint32));
            _checkLimits(f, m, cd);
        }
        id = ++nextChangeId;
        Change storage c = _changes[id];
        c.kind = kind;
        c.voterCount = uint16(_wallets.length);
        c.createdAt = uint64(block.timestamp);
        c.data = data;
        _voteChange(id, c);
    }

    function voteChange(uint256 id) external onlyWallet {
        Change storage c = _changes[id];
        if (c.createdAt == 0 || c.done || c.eta != 0) revert BadState();
        if (walletAddedAt[msg.sender] > c.createdAt) revert NotEligible();
        _voteChange(id, c);
    }

    function _voteChange(uint256 id, Change storage c) internal {
        if (hasVotedChange[id][msg.sender]) revert AlreadyVoted();
        hasVotedChange[id][msg.sender] = true;
        c.yes++;
        if (_majority(c.yes, c.voterCount)) {
            c.eta = uint64(block.timestamp + _timelock(c.kind));
            if (c.eta == block.timestamp) _apply(c);
        }
        hub.emitConfigChange(id, c.kind, c.data, c.yes, c.eta);
    }

    function executeChange(uint256 id) external {
        Change storage c = _changes[id];
        if (c.done || c.eta == 0) revert BadState();
        if (block.timestamp < c.eta) revert TimelockActive();
        _apply(c);
    }

    /// Any wallet can drop a loosening change a majority hasn't passed (e.g. an attacker's wallet-add). Protective
    /// changes (remove wallet, unfreeze, migrate) can't be cancelled, or one hacked wallet could block recovery.
    function cancelChange(uint256 id) external onlyWallet {
        Change storage c = _changes[id];
        if (c.createdAt == 0 || c.done || c.eta != 0) revert BadState();
        if (c.kind == T.CHANGE_REMOVE_WALLET || c.kind == T.CHANGE_UNFREEZE || c.kind == T.CHANGE_MIGRATE) {
            revert NotCancellable();
        }
        c.done = true;
        if (c.kind == T.CHANGE_ADD_WALLET) pendingWalletAdds--;
    }

    function _timelock(uint8 kind) internal pure returns (uint256) {
        if (kind == T.CHANGE_REMOVE_WALLET || kind == T.CHANGE_UNFREEZE || kind == T.CHANGE_MIGRATE) return 0;
        if (kind == T.CHANGE_RECOVERY_VAULT || kind == T.CHANGE_RECOVERY_KEY) return LONG_TIMELOCK;
        return SHORT_TIMELOCK;
    }

    function _apply(Change storage c) internal {
        c.done = true;
        uint8 k = c.kind;
        bytes memory d = c.data;
        if (k == T.CHANGE_ADD_WALLET) {
            pendingWalletAdds--;
            _addWallet(abi.decode(d, (address)));
        } else if (k == T.CHANGE_REMOVE_WALLET) {
            _removeWallet(abi.decode(d, (address)));
        } else if (k == T.CHANGE_BUDGET) {
            (budget24h, budget7d) = abi.decode(d, (uint128, uint128));
        } else if (k == T.CHANGE_LIMITS) {
            (hardCap, floorDelay, maxDelay, capDelay) = abi.decode(d, (uint128, uint32, uint32, uint32));
        } else if (k == T.CHANGE_ADD_DESTINATION) {
            isDestination[abi.decode(d, (address))] = true;
        } else if (k == T.CHANGE_ADD_DELEGATE) {
            isApprovedDelegate[abi.decode(d, (address))] = true;
        } else if (k == T.CHANGE_RECOVERY_VAULT) {
            recoveryVault = abi.decode(d, (address));
        } else if (k == T.CHANGE_RECOVERY_KEY) {
            recoveryKey = abi.decode(d, (address));
        } else if (k == T.CHANGE_UNFREEZE) {
            hub.vaultUnfreeze();
        } else {
            _migrate();
        }
    }

    // ------------------------------------------------------------------
    // Recovery key (optional, cold): unfreeze or migrate, never spend
    // ------------------------------------------------------------------

    function recoveryUnfreeze() external {
        if (msg.sender != recoveryKey || recoveryKey == address(0)) revert NotRecoveryKey();
        hub.vaultUnfreeze();
    }

    function recoveryMigrate() external {
        if (msg.sender != recoveryKey || recoveryKey == address(0)) revert NotRecoveryKey();
        _migrate();
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getChange(uint256 id) external view returns (Change memory) {
        return _changes[id];
    }

    /// Executed outflows, oldest first (≤ HISTORY).
    function history() public view returns (T.Outflow[] memory out) {
        uint256 n = historyCount < HISTORY ? historyCount : HISTORY;
        out = new T.Outflow[](n);
        uint256 start = historyCount - n;
        for (uint256 i; i < n; i++) {
            out[i] = _history[(start + i) % HISTORY];
        }
    }

    struct Profile {
        uint8 bizStartHourUtc;
        uint8 bizEndHourUtc;
        uint128 usualMaxPayout;
        uint128 hardCap;
        uint32 floorDelay;
        uint32 maxDelay;
        uint32 capDelay;
    }

    struct ScoringContext {
        Request request;
        T.Outflow[] history;
        uint256 destinationCount;
        bool knownDestination;
        Profile profile;
        bool configChangePending;
        uint64 requesterAddedAt;
        address requesterDelegation;
        uint256 walletCount;
    }

    /// Everything the Sentinel needs to score one request, in one EVM read (CRE quota: 15 reads/execution).
    function scoringContext(uint256 id) external view returns (ScoringContext memory ctx) {
        Request memory r = _requests[id];
        ctx.request = r;
        ctx.history = history();
        ctx.destinationCount = destinationCount[r.destination];
        ctx.knownDestination = isDestination[r.destination];
        ctx.profile = Profile(bizStartHourUtc, bizEndHourUtc, usualMaxPayout, hardCap, floorDelay, maxDelay, capDelay);
        ctx.configChangePending = pendingWalletAdds > 0;
        ctx.requesterAddedAt = walletAddedAt[r.requester];
        ctx.requesterDelegation = delegationOf(r.requester);
        ctx.walletCount = _wallets.length;
    }

    /// Reconciler: reserves vs supply.
    function reserves() external view returns (uint256 held, uint256 supply) {
        held = IERC20(usdc).balanceOf(address(this));
        supply = ProtectedToken(token).totalSupply();
    }

    /// Reconciler: each wallet's 7702 delegation target and whether it is approved.
    function delegations() external view returns (address[] memory ws, address[] memory targets, bool[] memory ok) {
        ws = _wallets;
        targets = new address[](ws.length);
        ok = new bool[](ws.length);
        for (uint256 i; i < ws.length; i++) {
            targets[i] = delegationOf(ws[i]);
            ok[i] = targets[i] == address(0) || isApprovedDelegate[targets[i]];
        }
    }
}
