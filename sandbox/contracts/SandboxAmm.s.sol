// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Script.sol";

/**
 * @title SandboxAmm
 * @notice SANDBOX-OWNED liquidity/swap driver for the two REAL Uniswap v3
 *         pools this sandbox deploys on anvil (see scripts/seed-toon-evm-amm.sh).
 *         Mounted read-only at /sandbox-extras in the anvil container, exactly
 *         like DeploySandboxExtras.s.sol, and run by absolute path from the
 *         connector's Foundry project root so the connector checkout is never
 *         written to.
 *
 * WHY THIS CONTRACT EXISTS AT ALL
 * ------------------------------
 * A Uniswap v3 core pool never pulls tokens itself. `mint` and `swap` call BACK
 * into `msg.sender` (`uniswapV3MintCallback` / `uniswapV3SwapCallback`) and
 * expect the owed tokens to have arrived by the time the callback returns. So
 * the caller MUST be a contract. Upstream's answer is the v3-PERIPHERY
 * (NonfungiblePositionManager + SwapRouter), ~40 KB of contracts whose only
 * job here would be to hold one full-range position and forward swaps. This is
 * the 60-line version of exactly that, and it keeps the sandbox's dependency on
 * Uniswap down to v3-CORE — the part whose `observe()` semantics the
 * connector's TWAP rate source actually reads (connector ADR 0071,
 * crates/connector-rate-source-evm).
 *
 * It is deliberately NOT a router: it holds the tokens, it holds the position,
 * and it pays its own callbacks out of its own balance. Nothing here is
 * production-shaped and nothing should ever be copied out of this file.
 *
 * DETERMINISM: broadcast from anvil account 8 (0x2361…1E8f) at nonce 1 — the
 * factory (deployed from committed mainnet-identical creation bytecode by
 * `cast send --create`) is that account's nonce 0. Neither address depends on
 * the connector's DeployLocal.s.sol, which uses account 0, nor on
 * DeploySandboxExtras.s.sol, which uses account 9.
 *
 *   UniswapV3Factory  0x5a2a35A0B70c13cd67F0F0Eb99D6D9A0A6555C6A  (acct 8, nonce 0)
 *   SandboxAmm        0x0d9A7dF9b0Db0f11b6a0e3ab0f10D1d0A3D6cF5C  (acct 8, nonce 1)
 *
 * The `require`s in the deploy script below make any drift loud at deploy time
 * instead of a downstream mystery; the real values are asserted by
 * scripts/seed-toon-evm-amm.sh against the committed connector config.
 */

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function tickSpacing() external view returns (int24);
    function initialize(uint160 sqrtPriceX96) external;
    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface IUniswapV3Factory {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IERC20Minimal {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

contract SandboxAmm {
    /// TickMath.MIN_SQRT_RATIO / MAX_SQRT_RATIO, v3-core `TickMath.sol`. A swap
    /// that names no useful price limit still has to name a legal one.
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    /// The pool is calling us back for what the mint owed it. `msg.sender` is
    /// the pool — v3-core has no other caller of this selector — and the tokens
    /// come out of this contract's own balance, which the seed script funded.
    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        if (amount0Owed > 0) IERC20Minimal(IUniswapV3Pool(msg.sender).token0()).transfer(msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20Minimal(IUniswapV3Pool(msg.sender).token1()).transfer(msg.sender, amount1Owed);
    }

    /// Same, for a swap. A NEGATIVE delta is what the pool owes US and is
    /// already in our balance by the time this runs; only the positive side is
    /// a debt to pay.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (amount0Delta > 0) {
            IERC20Minimal(IUniswapV3Pool(msg.sender).token0()).transfer(msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            IERC20Minimal(IUniswapV3Pool(msg.sender).token1()).transfer(msg.sender, uint256(amount1Delta));
        }
    }

    /// One FULL-RANGE position, which is what makes the sandbox's price a clean
    /// constant-product curve the swap driver can reason about with arithmetic
    /// rather than with tick math.
    function provide(address pool, int24 tickLower, int24 tickUpper, uint128 liquidity) external {
        IUniswapV3Pool(pool).mint(address(this), tickLower, tickUpper, liquidity, "");
    }

    /// Exact-input swap with no price limit beyond the legal one. Returns the
    /// pool's post-swap tick so the driver can steer on it.
    function trade(address pool, bool zeroForOne, int256 amountIn) external returns (int24 tick) {
        IUniswapV3Pool(pool).swap(
            address(this),
            zeroForOne,
            amountIn,
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            ""
        );
        (, tick,,,,,) = IUniswapV3Pool(pool).slot0();
    }

    /// The one number the swap driver steers on, as ONE value: `cast` prints a
    /// tuple across several lines and a shell parsing the second of them is a
    /// bug waiting for a field to be added to `slot0`.
    function tickOf(address pool) external view returns (int24 tick) {
        (, tick,,,,,) = IUniswapV3Pool(pool).slot0();
    }

    /// Read-only convenience for the seed script's log line and the smoke
    /// test's cardinality assertion.
    function state(address pool)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16 cardinality, uint16 cardinalityNext)
    {
        (sqrtPriceX96, tick,, cardinality, cardinalityNext,,) = IUniswapV3Pool(pool).slot0();
    }
}

contract DeploySandboxAmmScript is Script {
    // anvil account 8 (public test key, local chain only) — dedicated to the
    // AMM layer so its nonces are independent of DeployLocal (account 0) and
    // DeploySandboxExtras (account 9).
    uint256 internal constant DEPLOYER_KEY = 0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97;

    function run() external {
        vm.startBroadcast(DEPLOYER_KEY);
        SandboxAmm amm = new SandboxAmm();
        vm.stopBroadcast();
        console.log("SANDBOX_AMM_ADDRESS=%s", address(amm));
    }
}
