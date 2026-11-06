// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {PalmTypes} from "../libraries/PalmTypes.sol";

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

interface IWETH9 {
    function deposit() external payable;
    function withdraw(uint256) external;
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// CRE consumer interface (KeystoneForwarder calls this).
interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// Minimal ENSv2 surfaces we call. The ENS sources pin solc 0.8.25, so we talk to them through interfaces.
interface IEnsRegistrar {
    function register(
        string calldata label,
        address owner,
        address registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId);
    function unregister(uint256 anyId) external;
}

interface IEnsResolver {
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;
    function setText(bytes calldata name, string calldata key, string calldata value) external;
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

interface IVault {
    // views used by Hub, hook, router, registry, CRE
    function institution() external view returns (bool);
    function owner() external view returns (address);
    function recoveryVault() external view returns (address);
    function defaultReceiver() external view returns (address);
    function isHotWallet(address) external view returns (bool);
    function protectedToken(address underlying) external view returns (address);
    function underlyings() external view returns (address[] memory);
    function availableBudgetUsd() external view returns (uint256);

    // Hub-only
    function applyVerdict(uint256 requestId, bytes32 requestHash, uint8 verdict, uint256 reasonCodes)
        external
        returns (uint8 rejectReason, address destination);

    // NetworkRegistry-only (Vote: migrate to the affected Member's own Recovery vault)
    function voteMigrate() external;

    // Network transfers: payee side, callable only by another factory Vault
    function receiveNetworkTransfer(address underlying, uint256 amount) external;

    // VaultHook-only (one policy engine: the hook calls into the Vault's wrap/unwrap)
    function hookWrap(address underlying, uint256 amount) external;
    function hookUnwrap(address underlying, uint256 amount, address swapper) external;
}

interface IHub {
    function statusOf(address vault) external view returns (uint8);
    function marketMode(address underlying) external view returns (uint8);
    function isBlocked(address account) external view returns (bool);
    function isVault(address vault) external view returns (bool);

    // Vault → Hub (event router + status transitions a Vault may trigger itself)
    function emitUnwrapRequested(
        uint256 requestId,
        bytes32 requestHash,
        address asset,
        uint256 amount,
        address destination,
        uint256 usdValue,
        uint256 reasonCodes
    ) external;
    function emitRequestUpdated(uint256 requestId, uint8 state, uint64 executableAt, uint256 reasonCodes) external;
    function emitConfigChangeRequested(uint256 changeId, uint8 kind, bytes calldata data, uint64 eta) external;
    function emitSecondFactorConfirmed(uint256 requestId, bytes32 requestHash) external;
    function emitHookSwap(address hotWallet, address asset, uint256 amount, bool isUnwrap, uint256 usdValue) external;
    function emitSafeHarborSwap(address hotWallet, uint256 amountIn, uint256 amountOut, uint256 minOut) external;
    function emitNetworkTransfer(address payee, address asset, uint256 amount) external;
    function vaultUnfreeze() external;
    function vaultMigrated(address recoveryVault) external;
    function vaultPaused(bool paused) external;
}

interface INetworkRegistry {
    function isBlocked(address account) external view returns (bool);
    function addToBlocklist(address account, address sourceVault) external;
}

interface IVaultFactory {
    function isVault(address) external view returns (bool);
    function hook() external view returns (address);
    function safeHarborSwapper() external view returns (address);
}

/// Swaps WETH→USDC through allowlisted v4 pool keys on behalf of a Vault (Safe-harbor swaps).
/// The Vault enforces the Chainlink-checked minimum output itself, so a bad pool can't extract value past the cap.
interface ISafeHarborSwapper {
    /// Pulls `amountIn` WETH already transferred by the Vault, swaps it and sends USDC back to `msg.sender`.
    function swap(uint256 amountIn, uint256 minOut, bytes calldata route) external returns (uint256 amountOut);
}
