// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {External} from "./SepoliaConfig.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {FeeController} from "@tjar/FeeController.sol";
import {Factory as JarFactory} from "@tjar/Factory.sol";
import {VaultFactory} from "../../src/VaultFactory.sol";
import {IAggregatorV3} from "../../src/interfaces/IPalm.sol";
import {VaultHook} from "../../src/uniswap/VaultHook.sol";
import {PaymentRouter} from "../../src/uniswap/PaymentRouter.sol";
import {SafeHarborSwapper} from "../../src/uniswap/SafeHarborSwapper.sol";
import {PoolSeeder} from "../../src/uniswap/PoolSeeder.sol";

interface IERC20Min {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

/// palmfi's Uniswap pieces, deployed on top of the core network.
struct UniswapDeployment {
    address hook;
    address paymentRouter;
    address safeHarborSwapper;
    address poolSeeder;
    address jarFeeController;
    address jarFactory;
    address tokenJar;
    address jarReleaser;
    PoolKey wethUsdcKey; // Safe-harbor pool (allowlisted)
    PoolKey linkUsdcKey; // payments pool
    bool seeded;
}

/// Uniswap v4 + TJAR wiring, called at the end of NetworkDeployer.deployNetwork. Same sender rules as the
/// network deploy (broadcast in the script, prank in tests).
abstract contract UniswapDeployer {
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    uint160 internal constant HOOK_FLAGS = uint160(
        Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
            | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
    );

    uint256 internal constant JAR_THRESHOLD = 25e6; // 25 USDC
    uint24 internal constant WETH_USDC_FEE = 500;
    int24 internal constant WETH_USDC_SPACING = 10;
    uint24 internal constant LINK_USDC_FEE = 3000;
    int24 internal constant LINK_USDC_SPACING = 60;
    uint256 internal constant SEED_USDC_PER_POOL = 40e6; // per pool; the other side is priced off Chainlink
    int24 internal constant SEED_WIDTH_TICKS = 500; // about ±5% around the Chainlink price

    function deployUniswap(External memory e, address deployer, address factory, address hub, address safetyFund)
        internal
        returns (UniswapDeployment memory u)
    {
        bytes32 salt = keccak256(abi.encode("palmfi.uniswap", factory));

        // --- TJAR (not on Sepolia): our own FeeController (ops owner = deployer), Factory, one USDC jar ---
        u.jarFeeController = address(new FeeController(deployer));
        u.jarFactory = address(new JarFactory(u.jarFeeController));
        (u.tokenJar, u.jarReleaser) =
            JarFactory(u.jarFactory).deploy(e.usdc, safetyFund, JAR_THRESHOLD, deployer, address(0), salt);

        // --- PaymentRouter, then the hook (its trusted-router set includes the PaymentRouter) ---
        u.paymentRouter = address(new PaymentRouter(e.universalRouter, e.permit2, factory, hub, u.tokenJar));
        bytes memory initcode = abi.encodePacked(
            type(VaultHook).creationCode,
            abi.encode(IPoolManager(e.poolManager), factory, e.universalRouter, e.v4Quoter, u.paymentRouter)
        );
        u.hook = _create2(_mineHookSalt(keccak256(initcode)), initcode);
        require(uint160(u.hook) & Hooks.ALL_HOOK_MASK == HOOK_FLAGS, "hook flags");

        // --- plain pools for Safe-harbor swaps and payments ---
        u.wethUsdcKey = _plainKey(e.weth, e.usdc, WETH_USDC_FEE, WETH_USDC_SPACING);
        u.linkUsdcKey = _plainKey(e.link, e.usdc, LINK_USDC_FEE, LINK_USDC_SPACING);
        PoolKey[] memory allow = new PoolKey[](1);
        allow[0] = u.wethUsdcKey;
        u.safeHarborSwapper =
            address(new SafeHarborSwapper(IPoolManager(e.poolManager), factory, e.weth, e.usdc, allow));

        VaultFactory(factory).setHook(u.hook);
        VaultFactory(factory).setSafeHarborSwapper(u.safeHarborSwapper);
        VaultFactory(factory).setTokenJar(u.tokenJar);

        // --- seed with real tokens when the deployer holds them (fork tests `deal` them first) ---
        u.poolSeeder = address(new PoolSeeder(IPoolManager(e.poolManager)));
        u.seeded = _seed(e, deployer, u);
    }

    function _seed(External memory e, address deployer, UniswapDeployment memory u) internal returns (bool) {
        if (IERC20Min(e.usdc).balanceOf(deployer) < 2 * SEED_USDC_PER_POOL) return false;
        if (IERC20Min(e.weth).balanceOf(deployer) == 0 || IERC20Min(e.link).balanceOf(deployer) == 0) return false;
        _seedPool(u.poolSeeder, u.wethUsdcKey, e.usdc, e.ethUsdFeed, deployer);
        _seedPool(u.poolSeeder, u.linkUsdcKey, e.usdc, e.linkUsdFeed, deployer);
        return true;
    }

    /// One concentrated position around the Chainlink price (USDC taken as $1).
    function _seedPool(address seeder, PoolKey memory key, address usdc, address feed, address deployer) internal {
        (, int256 answer,,,) = IAggregatorV3(feed).latestRoundData();
        uint256 px = uint256(answer) * 1e8 / (10 ** IAggregatorV3(feed).decimals()); // 8dp USD
        address t0 = Currency.unwrap(key.currency0);
        address t1 = Currency.unwrap(key.currency1);
        uint256 usd0 = t0 == usdc ? 1e8 : px;
        uint256 usd1 = t1 == usdc ? 1e8 : px;
        uint160 sqrtP = PoolSeeder(seeder).sqrtPriceFromUsd(usd0, IERC20Min(t0).decimals(), usd1, IERC20Min(t1).decimals());
        uint256 max0 = t0 == usdc ? SEED_USDC_PER_POOL : IERC20Min(t0).balanceOf(deployer);
        uint256 max1 = t1 == usdc ? SEED_USDC_PER_POOL : IERC20Min(t1).balanceOf(deployer);
        IERC20Min(t0).approve(seeder, max0);
        IERC20Min(t1).approve(seeder, max1);
        PoolSeeder(seeder).seed(key, sqrtP, SEED_WIDTH_TICKS, max0, max1);
        IERC20Min(t0).approve(seeder, 0);
        IERC20Min(t1).approve(seeder, 0);
    }

    function _plainKey(address a, address b, uint24 fee, int24 spacing) internal pure returns (PoolKey memory) {
        (address c0, address c1) = a < b ? (a, b) : (b, a);
        return PoolKey(Currency.wrap(c0), Currency.wrap(c1), fee, spacing, IHooks(address(0)));
    }

    /// HookMiner (v4-hooks-public) logic with the initcode hash computed once.
    function _mineHookSalt(bytes32 initcodeHash) internal view returns (bytes32) {
        for (uint256 salt; salt < 1_000_000; salt++) {
            address a = address(
                uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initcodeHash))))
            );
            if (uint160(a) & Hooks.ALL_HOOK_MASK == HOOK_FLAGS && a.code.length == 0) return bytes32(salt);
        }
        revert("hook salt");
    }

    function _create2(bytes32 salt, bytes memory initcode) internal returns (address a) {
        (bool ok, bytes memory ret) = CREATE2_DEPLOYER.call(abi.encodePacked(salt, initcode));
        require(ok && ret.length == 20, "create2");
        a = address(bytes20(ret));
    }
}
