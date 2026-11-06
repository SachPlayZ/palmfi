// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

interface IHotWalletRegistry {
    function isHotWallet(address account) external view returns (bool);
}

/// An Owner's personal wrapped token for one Underlying (ADR-0006).
/// Standard ERC-20 surface so wallets show balances, but a transfer is allowed only:
///  - between the Owner's own Hot wallets,
///  - into the Uniswap PoolManager (hook wraps, routes, ERC-6909 claims),
///  - out of the PoolManager to one of the Owner's Hot wallets, or back to the Vault (hook unwraps).
/// Only the Vault mints and burns. Deployed as an EIP-1167 clone per (Vault, Underlying).
contract ProtectedToken {
    string public name;
    string public symbol;
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public vault;
    address public underlying;
    address public poolManager;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error AlreadyInitialized();
    error OnlyVault();
    error TransferNotAllowed(address from, address to);
    error InsufficientBalance();
    error InsufficientAllowance();

    function initialize(
        address vault_,
        address underlying_,
        address poolManager_,
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_
    ) external {
        if (vault != address(0)) revert AlreadyInitialized();
        vault = vault_;
        underlying = underlying_;
        poolManager = poolManager_;
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    // --- Vault-only supply changes ---

    function mint(address to, uint256 amount) external {
        if (msg.sender != vault) revert OnlyVault();
        if (to != poolManager && !_isHot(to)) revert TransferNotAllowed(address(0), to);
        totalSupply += amount;
        unchecked {
            balanceOf[to] += amount;
        }
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        if (msg.sender != vault) revert OnlyVault();
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - amount;
            totalSupply -= amount;
        }
        emit Transfer(from, address(0), amount);
    }

    // --- ERC-20 ---

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < amount) revert InsufficientAllowance();
            unchecked {
                allowance[from][msg.sender] = allowed - amount;
            }
        }
        _transfer(from, to, amount);
        return true;
    }

    /// The whitelist rule, readable by apps before they build a transfer.
    function canTransfer(address from, address to) public view returns (bool) {
        if (from == poolManager) return to == vault || _isHot(to);
        if (to == poolManager) return _isHot(from) || from == vault;
        return _isHot(from) && _isHot(to);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (!canTransfer(from, to)) revert TransferNotAllowed(from, to);
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - amount;
            balanceOf[to] += amount;
        }
        emit Transfer(from, to, amount);
    }

    function _isHot(address a) internal view returns (bool) {
        return IHotWalletRegistry(vault).isHotWallet(a);
    }
}
