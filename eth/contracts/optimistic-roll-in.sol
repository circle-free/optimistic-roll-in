pragma solidity >=0.6.0 <0.7.1;

// SPDX-License-Identifier: MIT

import "../node_modules/merkle-trees/eth/contracts/merkle-library.sol";

// TODO: roll up each user's balance, states_root, args_root, and locked into one bytes32
// TODO: more efficient merkle tree library (redundant steps being done in some places)
// TODO: a way to notify the network of a pending pruning, delayed by a certain number of blocks
// TODO: make args calldata somehow (msg.data contains the functions and the encoded params)
// TODO: allow an arbitrary amount of state transitions to be called
// TODO: if states are themselves roots, then calldata will contains sub tree proofs (doesn't matter, arbitrary calldata)

contract Optimistic_Roll_In {
  event Bonded(address user, uint256 amount);
  event Initialized(address user);
  event Withdrawal(address user, address destination, uint256 amount);
  event New_State(address user, bytes32 new_state);
  event New_Optimistic_State(address user);
  event New_Optimistic_States(address user);
  event Locked(address suspect, address accuser);
  event Unlocked(address suspect, address accuser);
  event Fraud_Proven(address accuser, address suspect, uint256 transition_index, uint256 amount);
  event Rolled_Back(address user, uint256 transition_index);
  event Prune_Requested(address user);
  event Pruned(address user);

  mapping(address => uint256) public balance;

  mapping(address => bytes32) public states_root;
  mapping(address => bytes32) public args_root;

  mapping(address => address) public locker;
  mapping(address => uint256) public locked_block;
  mapping(address => uint256) public rollback_size;

  receive() external payable {
    bond(msg.sender);
  }

  function bond(address user) public payable {
    uint256 amount = msg.value;
    balance[user] += amount;
    require(balance[user] >= 1000000000000000000, "INSUFFICIENT_BOND");    // 1 ETH

    if (amount != 0) emit Bonded(user, amount);
  }

  function initialize() public payable {
    address user = msg.sender;
    bond(user);

    require(states_root[user] == bytes32(0), "ALREADY_INITIALIZED");

    // Set the states_root to the merkle root of a 1-element (bytes32(0)) tree
    states_root[user] = bytes32(0x009316a6b27b778fc9c4cd520e332fce845aa0089877f87cfe8c1d77fa4cc110);

    emit Initialized(user);
  }

  function withdraw(address payable destination) public {
    address user = msg.sender;
    require(locker[user] == address(0), "ACCOUNT_LOCKED");

    uint256 amount = balance[user];
    balance[user] = 0;
    destination.transfer(amount);

    emit Withdrawal(user, destination, amount);
  }

  function get_new_state(bytes32 current_state, bytes32 arg) internal pure returns (bytes32) {
    // Just do some expensive work for the sake of the proof of concept
    for (uint256 i; i < 1000; ++i) {
      current_state = keccak256(abi.encodePacked(current_state, arg));
    }

    return current_state;
  }

  function verify_transition(bytes32 current_state, bytes32 arg, bytes32 new_state) internal pure returns (bool) {
    return get_new_state(current_state, arg) == new_state;
  }

  function perform(uint256 transition_index, bytes32 current_state, bytes32 arg, bytes32[] memory arg_append_proof, bytes32[] memory state_single_proof) public {
    address user = msg.sender;
    require(locker[user] == address(0), "ACCOUNT_LOCKED");

    // Check that the current_state (and thereby transition_index) provided is the last (current_state_proof[0] is the tree size)
    require(transition_index == uint256(state_single_proof[0]) - 1);
    
    // Compute a new state and append it to the states tree, and append the arg to the args tree
    bytes32 new_state = get_new_state(current_state, arg);
    states_root[user] = Merkle_Library.try_append_one_using_one(states_root[user], transition_index, current_state, new_state, state_single_proof);
    args_root[user] = Merkle_Library.try_append_one(args_root[user], arg, arg_append_proof);

    // Emit the new state, such that the transaction on its own contains all information to be validated
    emit New_State(user, new_state);
  }

  function perform_optimistically(uint256 transition_index, bytes32 current_state, bytes32 arg, bytes32 new_state, bytes32[] memory arg_append_proof, bytes32[] memory state_single_proof) public {
    address user = msg.sender;
    require(locker[user] == address(0), "ACCOUNT_LOCKED");

    // Check that the current_state (and thereby transition_index) provided is the last (current_state_proof[0] is the tree size)
    require(transition_index == uint256(state_single_proof[0]) - 1);

    // Append the state to the states tree, and append the provided arg and to the args tree
    states_root[user] = Merkle_Library.try_append_one_using_one(states_root[user], transition_index, current_state, new_state, state_single_proof);
    args_root[user] = Merkle_Library.try_append_one(args_root[user], arg, arg_append_proof);

    emit New_Optimistic_State(user);
  }

  function perform_many_optimistically(uint256 transition_index, bytes32 current_state, bytes32[] memory args, bytes32[] memory new_states, bytes32[] memory arg_append_proof, bytes32[] memory state_single_proof) public {
    address user = msg.sender;
    require(locker[user] == address(0), "ACCOUNT_LOCKED");

    // Check that the current_state (and thereby transition_index) provided is the last (current_state_proof[0] is the tree size)
    require(transition_index == uint256(state_single_proof[0]) - 1);

    // Append the states to the states tree, and append the provided args and to the args tree
    states_root[user] = Merkle_Library.try_append_many_using_one(states_root[user], transition_index, current_state, new_states, state_single_proof);
    args_root[user] = Merkle_Library.try_append_many(args_root[user], args, arg_append_proof);

    emit New_Optimistic_States(user);
  }

  function lock_user(address suspect) public payable {
    address accuser = msg.sender;

    // The accuser and the suspect cannot already be locked
    require(locker[accuser] == address(0), "ACCUSER_LOCKED");
    require(locker[suspect] == address(0), "SUSPECT_LOCKED");

    // Lock both the accuser and the suspect
    locker[suspect] = accuser;
    locked_block[suspect] = block.number;
    locker[accuser] = accuser;
    locked_block[accuser] = block.number;

    // The accuser may be trying to bond at the same time (this also check that have enough bonded)
    bond(accuser);

    emit Locked(suspect, accuser);
  }

  function unlock() public {
    address suspect = msg.sender;

    // Can only unlock a locked account if enough blocks have passed, and rollback not required
    require(locker[suspect] != address(0), "ALREADY_UNLOCKED");
    require(locked_block[suspect] + 100 <= block.number, "INSUFFICIENT_WINDOW");
    require(rollback_size[suspect] == 0, "REQUIRES_ROLLBACK");

    // Unlock both accounts
    address accuser = locker[suspect];
    locker[suspect] = address(0);
    locked_block[suspect] = 0;
    locker[accuser] = address(0);
    locked_block[accuser] = 0;

    // Give the suspect the accuser's bond for having not proven fraud within a reasonable time frame
    uint256 amount = balance[accuser];
    balance[accuser] = 0;
    balance[suspect] += amount;

    emit Unlocked(suspect, accuser);
  }

  function prove_fraud(address suspect, uint256 transition_index, bytes32 arg, bytes32[] memory states, bytes32[] memory arg_proof, bytes32[] memory states_proof) public {
    address accuser = msg.sender;

    // Only the user that flagged/locked the suspect can prove fraud
    require(locker[suspect] == accuser, "NOT_LOCKER");

    // Check that states and args involved in that transition index exist in their respective roots
    Merkle_Library.elements_exist(states_root[suspect], states, states_proof);
    Merkle_Library.element_exists(args_root[suspect], transition_index, arg, arg_proof);

    // Check that states provided are consecutive and regarding that transition index
    uint256[] memory state_indices = Merkle_Library.get_indices(states, states_proof);
    require(state_indices[0] == transition_index);
    require(state_indices[1] == transition_index + 1);

    // Fail if the state transition was valid
    require(verify_transition(states[0], arg, states[1]) == false, "VALID_TRANSITION");

    // Take the suspect's bond and give it to the accuser
    uint256 amount = balance[suspect];
    balance[suspect] = 0;
    balance[accuser] += amount;

    // Unlock the accuser's account
    locker[accuser] = address(0);
    locked_block[accuser] = 0;

    // Set the rollback size to the amount of elements that should be in the states tree once rolled back
    rollback_size[suspect] = transition_index + 1;

    // Set the suspect as the reason for their account's lock
    locker[suspect] = suspect;
    locked_block[suspect] = 0;

    emit Fraud_Proven(accuser, suspect, transition_index, amount);
  }

  function rollback(bytes32 old_args_root, bytes32 old_states_root, bytes32[] memory rolled_back_args, bytes32[] memory rolled_back_states, bytes32[] memory arg_append_proof, bytes32[] memory state_append_proof) public payable {
    address user = msg.sender;
    uint256 expected_size = rollback_size[user];
    require(expected_size != 0, "ROLLBACK_UNNECESSARY");

    // Check that the rolled back args and rolled back states match in length
    require(rolled_back_args.length == rolled_back_states.length, "LENGTH_MISMATCH");

    // Check that the size of the old, rolled back, states tree (defined by the states append proof) is as expected for the rollback
    require(uint256(state_append_proof[0]) == expected_size, "INVALID_ROLLBACK");
    
    expected_size--;

    // Check that the size of the old, rolled back, args tree defined by the args append proof is as expected for the rollback
    require(uint256(arg_append_proof[0]) == expected_size, "INVALID_ROLLBACK");

    // Check that the states root and args_root are derived from appending the 
    require(Merkle_Library.try_append_many(old_args_root, rolled_back_args, arg_append_proof) == args_root[user], "INVALID_ROLLBACK");
    require(Merkle_Library.try_append_many(old_states_root, rolled_back_states, state_append_proof) == states_root[user], "INVALID_ROLLBACK");

    // Set the args root and states root as provided
    args_root[user] = old_args_root;
    states_root[user] = old_states_root;

    // Unlock the user and clear the rollback flag
    locker[user] = address(0);
    rollback_size[user] = 0;

    // The user may be trying to bond at the same time (this also check that have enough bonded)
    bond(user);

    emit Rolled_Back(user, expected_size);
  }

  function request_prune() public {
    address user = msg.sender;
    require(locker[user] == address(0), "ACCOUNT_LOCKED");

    // Set the user as the reason for their account's lock
    locker[user] = user;
    locked_block[user] = block.number;

    emit Prune_Requested(user);
  }

  function prune(uint256 transition_index, bytes32 current_state, bytes32[] memory current_state_proof) public {
    address user = msg.sender;
    require(locker[user] == user, "LOCKER_MISMATCH");
    require(locked_block[user] + 100 <= block.number, "INSUFFICIENT_DELAY");
    require(rollback_size[user] == 0, "ROLLBACK_REQUIRED");

    // Check that the the provided state is in the merkle tree
    Merkle_Library.element_exists(states_root[user], transition_index, current_state, current_state_proof);

    // Check that the index of the provided state (the transition index) is the last state
    require(transition_index == uint256(current_state_proof[0]) - 1);

    bytes32[] memory empty_proof = new bytes32[](1);
    empty_proof[0] = bytes32(0);

    // Compute a new state and append it to the states tree, and append the arg to the args tree
    states_root[user] = Merkle_Library.try_append_one(bytes32(0), current_state, empty_proof);
    args_root[user] = bytes32(0);

    // Clear prune request
    locker[user] = address(0);
    locked_block[user] = 0;

    emit Pruned(user);
  }
}
