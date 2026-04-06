// Minimal ABIs for the contracts the bot touches.
// Only the functions and events actually used are declared here.

// OTUSDT token contract: we read isLocked and write lockWallet,
// plus subscribe to the Transfer event.
export const OTUSDT_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function isLocked(address) view returns (bool)",
  "function lockWallet(address wallet) external",
  "function owner() view returns (address)",
  "function gatewayContract() view returns (address)",
];

// Chainlink AggregatorV3Interface: we only read latestRoundData and decimals.
export const CHAINLINK_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
];
