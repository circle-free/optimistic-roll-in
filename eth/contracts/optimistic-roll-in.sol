pragma solidity >=0.6.0 <0.7.1;

// SPDX-License-Identifier: MIT

import "../node_modules/merkle-trees/eth/contracts/merkle-library.sol";

// TODO: more efficient merkle tree library (redundant steps being done in some places)
// TODO: make args calldata somehow (msg.data contains the functions and the encoded params)
// TODO: allow an arbitrary amount of state transitions to be called
// TODO: if states are themselves roots, then calldata will contains sub tree proofs (doesn't matter, arbitrary calldata)

contract Optimistic_Roll_In {
  event New_State(address user, bytes32 new_state);
  event New_Optimistic_State(address user, uint256 block_time);
  event New_Optimistic_States(address user, uint256 block_time);
  event Locked(address suspect, address accuser);
  event Unlocked(address suspect, address accuser);
  event Fraud_Proven(address accuser, address suspect, uint256 transition_index, uint256 amount);
  event Rolled_Back(address user, uint256 transition_index, uint256 block_time);

  mapping(address => uint256) public balances;
  mapping(address => bytes32) public account_states;
  mapping(address => address) public lockers;
  mapping(address => uint256) public locked_times;
  mapping(address => uint256) public rollback_sizes;

  receive() external payable {
    bond(msg.sender);
  }

  // Bonds msg.value, and reverts if resulting balance less than 1 ETH
  function bond(address user) public payable {
    uint256 amount = msg.value;

    if (amount == 0) {
      require(balances[user] >= 1000000000000000000, "INSUFFICIENT_BOND");
      return;
    }

    balances[user] += amount;
    require(balances[user] >= 1000000000000000000, "INSUFFICIENT_BOND");
  }

  // Sets user's account state to starting point, and bonds msg.value
  function initialize() public payable {
    address user = msg.sender;
    bond(user);

    require(account_states[user] == bytes32(0), "ALREADY_INITIALIZED");

    // Set account state to combination of empty states root, empty args root, and last time of 0 (not in optimism)
    account_states[user] = keccak256(abi.encodePacked(bytes32(0), bytes32(0), bytes32(0)));
  }

  // Allows unbonding of ETH if account not locked
  function withdraw(address payable destination) public {
    address user = msg.sender;
    require(lockers[user] == address(0), "ACCOUNT_LOCKED");

    uint256 amount = balances[user];
    balances[user] = 0;
    destination.transfer(amount);
  }

  // TODO: This is a temporary example. Call to some other contract instead.
  function get_new_state(bytes32 current_state, bytes32 arg) internal pure returns (bytes32) {
    // Just do some expensive work for the sake of the proof of concept
    for (uint256 i; i < 1000; ++i) {
      current_state = keccak256(abi.encodePacked(current_state, arg));
    }

    return current_state;
  }

  // Returns true if function with args on current_state results in new_state
  // TODO: function may throw, so handle that possibility (try/catch)
  function verify_transition(
    bytes32 current_state,
    bytes32 arg,
    bytes32 new_state
  ) internal pure returns (bool) {
    return get_new_state(current_state, arg) == new_state;
  }

  // Set the account state to the on-chain computed new state, if the account is not locked
  function perform(bytes32 state, bytes32 arg) public {
    address user = msg.sender;
    require(lockers[user] == address(0), "ACCOUNT_LOCKED");

    // Check that the current state is the only state, the args root is empty, and the last block is 0
    require(keccak256(abi.encodePacked(state, bytes32(0), bytes32(0))) == account_states[user], "INVALID_ROOTS");

    // Compute a new state, reusing the state variable
    state = get_new_state(state, arg);

    // Set the account state to the new state, combined with no prior args, and last time 0
    account_states[user] = keccak256(abi.encodePacked(state, bytes32(0), bytes32(0)));

    emit New_State(user, state);
  }

  // Exits optimism by setting the account state to the on-chain computed new state, if the account is not locked
  function perform_and_exit(
    uint256 transition_index,
    bytes32 state,
    bytes32 arg,
    bytes32 args_root,
    bytes32 states_root,
    bytes32[] memory state_proof,
    uint256 last_time
  ) public {
    address user = msg.sender;
    require(lockers[user] == address(0), "ACCOUNT_LOCKED");
    require(rollback_sizes[user] == 0, "ROLLBACK_REQUIRED");

    // Check that the provided tree roots and last time are valid for this user
    require(keccak256(abi.encodePacked(states_root, args_root, bytes32(last_time))) == account_states[user], "INVALID_ROOTS");

    // Check that enough time has elapsed for potential fraud proofs (10 minutes)
    require(last_time + 600 < block.timestamp, "INSUFFICIENT_TIME");

    // Check that the the provided state is in the merkle tree
    require(Merkle_Library.element_exists(states_root, transition_index, state, state_proof), "INVALID_STATE");

    // Check that the index of the provided state (the transition index) is the last state
    require(transition_index == uint256(state_proof[0]) - 1);

    // Compute a new state, reusing state variable
    state = get_new_state(state, arg);

    // Set the account state to the new state, combined with no prior args, and last time 0
    account_states[user] = keccak256(abi.encodePacked(state, bytes32(0), bytes32(0)));
    
    emit New_State(user, state);
  }

  // Enters optimism by setting the account state to the optimistic new state and arg, if the account is not locked
  function perform_optimistically_and_enter(bytes32 arg, bytes32[] memory states) public {
    address user = msg.sender;
    require(lockers[user] == address(0), "ACCOUNT_LOCKED");

    // Check that only 2 states (current and new) are provided
    require(states.length == 2, "INVALID_REQUEST");

    // Check that the current state is the only state, the args root is empty, and the last time is 0
    require(keccak256(abi.encodePacked(states[0], bytes32(0), bytes32(0))) == account_states[user], "INVALID_ROOTS");

    // Get states root from merkle root of a 2-element tree
    bytes32[] memory proof = new bytes32[](1);
    proof[0] = bytes32(0);
    bytes32 states_root = Merkle_Library.try_append_many(bytes32(0), states, proof);

    // Get args root from merkle root of a 1-element tree, reusing arg var as states tree root
    arg = Merkle_Library.try_append_one(bytes32(0), arg, proof);

    // Combined states root, args root, current time into account state
    account_states[user] = keccak256(abi.encodePacked(states_root, arg, bytes32(block.timestamp)));

    emit New_Optimistic_State(user, block.timestamp);
  }

  // Updates the account state with the optimistic new state and arg, if the account is not locked
  function perform_optimistically(
    uint256 transition_index,
    bytes32 current_state,
    bytes32 arg,
    bytes32 new_state,
    bytes32 args_root,
    bytes32[] memory arg_append_proof,
    bytes32 states_root,
    bytes32[] memory state_single_proof,
    uint256 last_time
  ) public {
    address user = msg.sender;
    require(lockers[user] == address(0), "ACCOUNT_LOCKED");

    // Check that the current state (and thereby transition_index) provided is the last (current_state_proof[0] is the tree size)
    require(transition_index == uint256(state_single_proof[0]) - 1);

    // Check that the provided tree roots and last time are valid for this user
    require(keccak256(abi.encodePacked(states_root, args_root, bytes32(last_time))) == account_states[user], "INVALID_ROOTS");

    // Get the new states root
    states_root = Merkle_Library.try_append_one_using_one(
      states_root,
      transition_index,
      current_state,
      new_state,
      state_single_proof
    );

    // Get the new args root
    args_root = Merkle_Library.try_append_one(args_root, arg, arg_append_proof);

    // Combine both roots with the current time, into the account state
    account_states[user] = keccak256(abi.encodePacked(states_root, args_root, bytes32(block.timestamp)));

    emit New_Optimistic_State(user, block.timestamp);
  }

  // Enters optimism by setting the account state to the optimistic new states and args, if the account is not locked
  function perform_many_optimistically_and_enter(bytes32[] memory args, bytes32[] memory states) public {
    address user = msg.sender;
    require(lockers[user] == address(0), "ACCOUNT_LOCKED");

    // Check that only there are 1 more states than args, and at least 2 states (current and at least 1 new)
    uint256 states_length = states.length;
    require((states_length > 1) && (states_length == args.length + 1), "INVALID_REQUEST");

    // Check that the current state is the only state, the args root is empty, and the last time is 0
    require(keccak256(abi.encodePacked(states[0], bytes32(0), bytes32(0))) == account_states[user], "INVALID_ROOTS");

    // Get states root from merkle root of states tree
    bytes32[] memory proof = new bytes32[](1);
    proof[0] = bytes32(0);
    bytes32 states_root = Merkle_Library.try_append_many(bytes32(0), states, proof);

    // Get args root from merkle root of args tree
    bytes32 args_root = Merkle_Library.try_append_many(bytes32(0), args, proof);

    // Combined states root, args root, current time into account state
    account_states[user] = keccak256(abi.encodePacked(states_root, args_root, bytes32(block.timestamp)));

    emit New_Optimistic_State(user, block.timestamp);
  }

  // Updates the account state with the optimistic new states and args, if the account is not locked
  function perform_many_optimistically(
    uint256 transition_index,
    bytes32 current_state,
    bytes32[] memory args,
    bytes32[] memory new_states,
    bytes32 args_root,
    bytes32[] memory arg_append_proof,
    bytes32 states_root,
    bytes32[] memory state_single_proof,
    uint256 last_time
  ) public {
    address user = msg.sender;
    require(lockers[user] == address(0), "ACCOUNT_LOCKED");

    // Check that the current_state (and thereby transition_index) provided is the last (current_state_proof[0] is the tree size)
    require(transition_index == uint256(state_single_proof[0]) - 1);

    // Check that the provided tree roots and last time are valid for this user
    require(keccak256(abi.encodePacked(states_root, args_root, bytes32(last_time))) == account_states[user], "INVALID_ROOTS");

    // Get the new states root
    states_root = Merkle_Library.try_append_many_using_one(
      states_root,
      transition_index,
      current_state,
      new_states,
      state_single_proof
    );

    // Get the new args root
    args_root = Merkle_Library.try_append_many(args_root, args, arg_append_proof);

    // Combine both roots with the current time, into the account state
    account_states[user] = keccak256(abi.encodePacked(states_root, args_root, bytes32(block.timestamp)));

    emit New_Optimistic_States(user, block.timestamp);
  }

  // Lock two users (suspect and accuser)
  function lock_user(address suspect) public payable {
    address accuser = msg.sender;

    // The accuser and the suspect cannot already be locked
    // Note: This might have to be changed so a single accuser isn't overwhelmed with fraud
    require(lockers[accuser] == address(0), "ACCUSER_LOCKED");
    require(lockers[suspect] == address(0), "SUSPECT_LOCKED");

    // Lock both the accuser and the suspect
    lockers[suspect] = accuser;
    locked_times[suspect] = block.timestamp;
    lockers[accuser] = accuser;
    locked_times[accuser] = block.timestamp;

    // The accuser may be trying to bond at the same time (this also check that have enough bonded)
    bond(accuser);

    emit Locked(suspect, accuser);
  }

  // Unlock two users (suspect and accuser)
  function unlock(
    address suspect,
    bytes32 states_root,
    bytes32 args_root,
    uint256 last_time
  ) public {
    // Can only unlock a locked account if enough time has passed, and rollback not required
    require(lockers[suspect] != address(0), "ALREADY_UNLOCKED");
    require(locked_times[suspect] + 600 <= block.timestamp, "INSUFFICIENT_WINDOW");
    require(rollback_sizes[suspect] == 0, "REQUIRES_ROLLBACK");

    // Check that the provided tree roots and last time are valid for this user
    require(keccak256(abi.encodePacked(states_root, args_root, bytes32(last_time))) == account_states[suspect], "INVALID_ROOTS");

    // Unlock both accounts
    address accuser = lockers[suspect];
    lockers[suspect] = address(0);
    locked_times[suspect] = 0;
    lockers[accuser] = address(0);
    locked_times[accuser] = 0;

    // Give the suspect the accuser's bond for having not proven fraud within a reasonable time frame
    // TODO: consider burning some here to prevent self-reporting breakeven
    uint256 amount = balances[accuser];
    balances[accuser] = 0;
    balances[suspect] += amount;

    // Combine both roots with the current time, into the account state (updating last time is important)
    account_states[suspect] = keccak256(abi.encodePacked(states_root, args_root, bytes32(block.timestamp)));

    emit Unlocked(suspect, accuser);
  }

  // Reward accuser for proving fraud in a suspect's transition, and track the expected rolled back account state size
  function prove_fraud(
    address suspect,
    uint256 transition_index,
    bytes32 arg,
    bytes32[] memory states,
    bytes32 args_root,
    bytes32[] memory arg_proof,
    bytes32 states_root,
    bytes32[] memory states_proof,
    uint256 last_time
  ) public {
    address accuser = msg.sender;

    // Only the user that flagged/locked the suspect can prove fraud
    require(lockers[suspect] == accuser, "NOT_LOCKER");

    // Check that the provided tree roots and last time are valid for this suspect
    require(keccak256(abi.encodePacked(states_root, args_root, bytes32(last_time))) == account_states[suspect], "INVALID_ROOTS");

    // Check that states and args involved in that transition index exist in their respective roots
    require(Merkle_Library.elements_exist(states_root, states, states_proof), "INVALID_STATES");
    require(Merkle_Library.element_exists(args_root, transition_index, arg, arg_proof), "INVALID_ARG");

    // Check that states provided are consecutive and regarding that transition index
    uint256[] memory state_indices = Merkle_Library.get_indices(states, states_proof);
    require(state_indices[0] == transition_index);
    require(state_indices[1] == transition_index + 1);

    // Fail if the state transition was valid
    require(verify_transition(states[0], arg, states[1]) == false, "VALID_TRANSITION");

    // Take the suspect's bond and give it to the accuser
    // TODO: consider burning some here to prevent self-reporting breakeven
    uint256 amount = balances[suspect];
    balances[suspect] = 0;
    balances[accuser] += amount;

    // Unlock the accuser's account
    lockers[accuser] = address(0);
    locked_times[accuser] = 0;

    // Set the rollback size to the amount of elements that should be in the states tree once rolled back
    rollback_sizes[suspect] = transition_index + 1;

    // Set the suspect as the reason for their account's lock
    lockers[suspect] = suspect;
    locked_times[suspect] = 0;

    emit Fraud_Proven(accuser, suspect, transition_index, amount);
  }

  // Rolls a user back, given the current roots, old roots, and a proof of the optimistic transitions between them
  // Note: This can be improved to allow incremental rollbacks until the rollback size is met
  function rollback(
    bytes32 old_args_root,
    bytes32 old_states_root,
    bytes32[] memory rolled_back_args,
    bytes32[] memory rolled_back_states,
    bytes32 args_root,
    bytes32[] memory arg_append_proof,
    bytes32 states_root,
    bytes32[] memory state_append_proof,
    uint256 last_time
  ) public payable {
    address user = msg.sender;
    uint256 expected_size = rollback_sizes[user];
    require(expected_size != 0, "ROLLBACK_UNNECESSARY");

    // Check that the rolled back args and rolled back states match in length
    require(rolled_back_args.length == rolled_back_states.length, "LENGTH_MISMATCH");

    // Check that the size of the old, rolled back, states tree (defined by the states append proof) is as expected
    require(uint256(state_append_proof[0]) == expected_size, "INVALID_ROLLBACK");

    // Decrement here because arg tree is always one smaller in size
    expected_size -= 1;

    // Check that the size of the old, rolled back, args tree (defined by the args append proof) is as expected
    require(uint256(arg_append_proof[0]) == expected_size, "INVALID_ROLLBACK");

    // Check that the provided tree roots and last time are valid for this user
    require(keccak256(abi.encodePacked(states_root, args_root, bytes32(last_time))) == account_states[user], "INVALID_ROOTS");

    // Check that the states root is derived from appending the rolled back states to the old states root
    require(
      Merkle_Library.try_append_many(old_states_root, rolled_back_states, state_append_proof) == states_root,
      "INVALID_ROLLBACK"
    );

    // Check that the args root is derived from appending the rolled back args to the old args root
    require(
      Merkle_Library.try_append_many(old_args_root, rolled_back_args, arg_append_proof) == args_root,
      "INVALID_ROLLBACK"
    );

    // Combine both roots with the current time, into the account state
    account_states[user] = keccak256(abi.encodePacked(old_states_root, old_args_root, bytes32(block.timestamp)));

    // Unlock the user and clear the rollback flag
    lockers[user] = address(0);
    rollback_sizes[user] = 0;

    // The user may be trying to bond at the same time (this also check that have enough bonded)
    bond(user);

    emit Rolled_Back(user, expected_size, block.timestamp);
  }
}
