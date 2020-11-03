// SPDX-License-Identifier: MIT

pragma solidity >=0.6.0 <=0.7.3;
pragma experimental ABIEncoderV2;

import "./optimistic-roll-in-compatible.sol";

// TODO: Build a Logic Proxy that checks and embeds the version of the state, and directs to other contracts

contract Some_Logic_Contract is Optimistic_Roll_In_Compatible {
  event Impure_Transition(bytes32 data);

  function get_selector(bytes calldata call_data) internal pure returns (bytes4) {
    return call_data[0] | (bytes4(call_data[1]) >> 8) | (bytes4(call_data[2]) >> 16) | (bytes4(call_data[3]) >> 24);
  }

  function initialize_state(address user) external payable override returns (bytes32) {
    require(msg.value >= 500000000000000000, "INSUFFICIENT_DEPOSIT");
    return keccak256(abi.encodePacked(user));
  }

  function optimistic_entry_point(bytes calldata call_data) external view override returns (bytes32 new_state) {
    bytes4 selector = get_selector(call_data);
    require(selector == 0xef6f6a42, "INVALID_OPTIMISTIC_CALL");

    // Call (staticcall) local function
    // TODO: jump or low level function call would be more efficient
    (bool success, bytes memory state_bytes) = address(this).staticcall(call_data);
    require(success, "STATIC_CALL_FAILED");

    // Decode returned new_state
    new_state = abi.decode(state_bytes, (bytes32));
  }

  function pessimistic_entry_point(bytes calldata call_data) external payable override returns (bytes32 new_state) {
    bytes4 selector = get_selector(call_data);
    require(selector == 0x816ef0b6, "INVALID_PESSIMISTIC_CALL");

    // Call (staticcall) local function
    // TODO: jump or low level function call would be more efficient
    (bool success, bytes memory state_bytes) = address(this).call{ value: msg.value }(call_data);
    require(success, "CALL_FAILED");

    // Decode returned new_state
    new_state = abi.decode(state_bytes, (bytes32));
  }

  function some_pure_transition(
    address user,
    bytes32 current_state,
    bytes32 some_arg
  ) external pure returns (bytes32) {
    // Just do some expensive work for the sake of the proof of concept
    current_state = keccak256(abi.encodePacked(current_state, user));

    for (uint256 i; i < 1000; ++i) {
      current_state = keccak256(abi.encodePacked(current_state, some_arg));
    }

    return current_state;
  }

  function some_impure_transition(
    address user,
    bytes32 current_state,
    bytes32 some_arg
  ) external payable returns (bytes32 new_state) {
    // Just do some impure work for the sake of the proof of concept
    new_state = blockhash(block.number - 1);
    emit Impure_Transition(new_state);

    return keccak256(abi.encodePacked(current_state, user, some_arg, new_state));
  }
}
