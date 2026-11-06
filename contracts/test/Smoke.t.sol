// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {NetworkTest} from "./base/NetworkTest.sol";

interface IUniversalResolverRoot {
    function ROOT_REGISTRY() external view returns (address);
}

contract SmokeTest is NetworkTest {
    function test_forkSeesRealSepoliaDependencies() public view {
        assertGt(ext.poolManager.code.length, 0, "PoolManager");
        assertGt(ext.universalRouter.code.length, 0, "UniversalRouter");
        assertEq(IERC20Metadata(ext.usdc).symbol(), "USDC");
        assertEq(IERC20Metadata(ext.weth).symbol(), "WETH");
        assertEq(IUniversalResolverRoot(ext.ensUniversalResolver).ROOT_REGISTRY(), ext.ensRootRegistry);
        assertGt(ethUsdPrice(), 0, "ETH/USD feed");
    }

    function test_actorsAreDistinctAndFundable() public {
        address[8] memory all = [owner, hotWallet, attacker, guardian, recoveryKey, member, searcher, approver];
        for (uint256 i; i < all.length; i++) {
            for (uint256 j = i + 1; j < all.length; j++) {
                assertTrue(all[i] != all[j], "actors collide");
            }
        }

        fundUsdc(hotWallet, 100e6);
        fundWeth(hotWallet, 1 ether);

        assertEq(IERC20Metadata(ext.usdc).balanceOf(hotWallet), 100e6);
        assertEq(IERC20Metadata(ext.weth).balanceOf(hotWallet), 1 ether);
    }

    function test_forwarderImpersonationActsAsCreForwarder() public {
        asForwarder();
        (bool ok, bytes memory ret) = address(this).call(abi.encodeCall(this.whoCalls, ()));
        assertTrue(ok);
        assertEq(abi.decode(ret, (address)), ext.creSimForwarder);
    }

    function whoCalls() external view returns (address) {
        return msg.sender;
    }
}
