import { parseAbi } from 'viem';

/**
 * Verified ABI fragments (spec Appendix C). Human-readable form — viem parses
 * structs from the inline tuple syntax.
 */

// LFJ Liquidity Book v2.2 — LBPair
export const lbPairAbi = parseAbi([
  'function getSwapOut(uint128 amountIn, bool swapForY) view returns (uint128 amountInLeft, uint128 amountOut, uint128 fee)',
  'function getTokenX() view returns (address)',
  'function getTokenY() view returns (address)',
  'function getActiveId() view returns (uint24)',
  'function getBinStep() view returns (uint16)',
  'function getReserves() view returns (uint128 reserveX, uint128 reserveY)',
  'event Swap(address indexed sender, address indexed to, uint24 id, bytes32 amountsIn, bytes32 amountsOut, uint24 volatilityAccumulator, bytes32 totalFees, bytes32 protocolFees)',
]);

// LFJ — LBFactory (discovery)
export const lbFactoryAbi = parseAbi([
  'function getNumberOfLBPairs() view returns (uint256)',
  'function getAllLBPairs(address tokenX, address tokenY) view returns ((uint16 binStep, address LBPair, bool createdByOwner, bool ignoredForRouting)[])',
  'event LBPairCreated(address indexed tokenX, address indexed tokenY, uint256 indexed binStep, address LBPair, uint256 pid)',
]);

// Clober V2 — BookManager (core events)
export const bookManagerAbi = parseAbi([
  'event Take(uint192 indexed bookId, address indexed user, int24 tick, uint64 unit)',
  'event Open(uint192 indexed id, address indexed base, address indexed quote, uint64 unitSize, uint24 makerPolicy, uint24 takerPolicy, address hooks)',
  'event Make(uint192 indexed bookId, address indexed user, int24 tick, uint256 orderIndex, uint64 unit, address provider)',
]);

// Clober V2 — BookViewer (quoting)
export const bookViewerAbi = parseAbi([
  'function getExpectedOutput((uint192 id, uint256 limitPrice, uint256 baseAmount, uint256 minQuoteAmount, bytes hookData) params) view returns (uint256 takenQuoteAmount, uint256 spentBaseAmount)',
  'function getExpectedInput((uint192 id, uint256 limitPrice, uint256 quoteAmount, uint256 maxBaseAmount, bytes hookData) params) view returns (uint256 takenQuoteAmount, uint256 spentBaseAmount)',
]);

// Clober V2 — RouterGateway (routed flow)
export const routerGatewayAbi = parseAbi([
  'event Swap(address indexed user, address indexed inToken, address indexed outToken, uint256 amountIn, uint256 amountOut, address router, bytes4 method)',
]);

// Clober V2 — LiquidityVault (propAMM-cut tagging)
export const liquidityVaultAbi = parseAbi([
  'event Open(bytes32 indexed key, uint192 indexed bookIdA, uint192 indexed bookIdB, bytes32 salt, address strategy)',
]);

export const erc20Abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

/** Clober walk-whole-book sentinel (spec §5.1). */
export const CLOBER_MIN_PRICE = 1350587n;
