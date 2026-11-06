// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IOrbitalVault} from "../../src/orbital/IOrbitalVault.sol";
import {OrbitalHook} from "../../src/orbital/OrbitalHook.sol";

contract MockProtectedToken is ERC20 {
    constructor(string memory sym) ERC20(sym, sym) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Minimal IOrbitalVault: wallet whitelist, per-wallet instant budget, freeze flag.
contract MockOrbitalVault is IOrbitalVault {
    MockProtectedToken public immutable protected;
    OrbitalHook public hook;
    bool public isFrozen;
    mapping(address => bool) public isWallet;
    mapping(address => uint256) public budget;

    error NotHook();
    error NotWallet(address);
    error OverBudget(uint256 want, uint256 left);

    constructor(string memory sym) {
        protected = new MockProtectedToken(sym);
    }

    function token() external view returns (address) {
        return address(protected);
    }

    function setHook(OrbitalHook h) external {
        hook = h;
    }

    function setWallet(address w, uint256 b) external {
        isWallet[w] = true;
        budget[w] = b;
        protected.mint(w, 1_000_000e6);
    }

    function setFrozen(bool f) external {
        isFrozen = f;
    }

    /// LP own token: mint backing-equivalent and hand it to the hook.
    function provide(uint256 amount) external {
        protected.mint(address(this), amount);
        protected.approve(address(hook), amount);
        hook.addLiquidity(this, amount);
    }

    function chargeOutflow(address wallet, uint256 amount) external {
        if (msg.sender != address(hook)) revert NotHook();
        if (!isWallet[wallet]) revert NotWallet(wallet);
        if (amount > budget[wallet]) revert OverBudget(amount, budget[wallet]);
        budget[wallet] -= amount;
    }

    function settleOut(uint256, address) external pure {
        revert("settlement: #34");
    }

    function settleIn(uint256) external pure {
        revert("settlement: #34");
    }
}
