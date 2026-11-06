// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

/// CRE consumer interface (KeystoneForwarder calls this).
interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

interface IVault {
    function token() external view returns (address);
    function isWallet(address) external view returns (bool);
    function walletCount() external view returns (uint256);
    function recoveryVault() external view returns (address);

    // Hub-only (CRE reports). Never revert on content: return a reject reason instead (ADR-0005).
    function applyDelay(uint256 requestId, bytes32 requestHash, uint64 delay, uint32 score, uint256 reasonCodes)
        external
        returns (uint8 rejectReason);
    function applyFlag(uint256 requestId, bytes32 requestHash, uint32 score, uint256 reasonCodes)
        external
        returns (uint8 rejectReason, address destination);

    // Payee side of a vault-to-vault payment; callable only by another factory Vault.
    function receivePayment(uint256 amount) external;
}

interface IHub {
    function statusOf(address vault) external view returns (uint8);
    function isBlocked(address account) external view returns (bool);
    function isVault(address vault) external view returns (bool);
    /// CRE has written a heartbeat recently: every outflow must go through a scored request.
    function creLive() external view returns (bool);

    // Vault → Hub event router
    function emitRequestQueued(
        uint256 requestId,
        bytes32 requestHash,
        uint8 kind,
        address wallet,
        uint256 amount,
        address destination,
        uint256 reasonCodes
    ) external;
    function emitRequestUpdated(uint256 requestId, uint8 state, uint64 executableAt, uint32 score, uint256 reasonCodes)
        external;
    function emitVoted(uint256 requestId, address voter, bool yes, uint16 yesVotes, uint16 noVotes) external;
    function emitConfigChange(uint256 changeId, uint8 kind, bytes calldata data, uint16 yesVotes, uint64 eta) external;
    function emitOutflow(address wallet, address destination, uint256 amount, bool viaPool) external;

    // Status transitions a Vault may trigger itself
    function vaultFreeze(address by) external;
    function vaultUnfreeze() external;
    function vaultMigrated(address recoveryVault) external;
}

interface IVaultFactory {
    function isVault(address) external view returns (bool);
    function hook() external view returns (address);
}

/// The Orbital pool hook as the factory sees it (#33).
interface IOrbitalHookRegistry {
    function registerToken(address vault) external;
}
