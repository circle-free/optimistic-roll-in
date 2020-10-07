const chai = require('chai');
const { expect } = chai;
const { Keccak } = require('sha3');
const crypto = require('crypto');
const { MerkleTree, PartialMerkleTree } = require('merkle-trees/js');
const txDecoder = require('ethereum-tx-decoder');
const { abi: contractABI } = require('../build/contracts/Optimistic_Roll_In.json');

const Optimistic_Roll_In = artifacts.require("Optimistic_Roll_In");

const treeOptions = {
  unbalanced: true,
  sortedHash: false,
  elementPrefix: '0000000000000000000000000000000000000000000000000000000000000000',
};

const leftPad = (num, size, char = '0') => {
  let s = num + '';

  while (s.length < size) s = char + s;

  return s;
};

const to32ByteBuffer = (number) => Buffer.from(leftPad(number.toString(16), 64), 'hex');

const hash = (buffer) => new Keccak(256).update(buffer).digest();

const hashNode = (a, b) => hash(Buffer.concat([a, b]));

const generateRandomElement = () => {
  return crypto.randomBytes(32);
};

const generateElements = (elementCount, options = {}) => {
  const { seed, random = false } = options;
  const elements = [];
  let seedBuffer = seed ? Buffer.from(seed, 'hex') : null;
  let element = seedBuffer;

  for (let i = 0; i < elementCount; i++) {
    element = random ? generateRandomElement() : seed ? hashNode(seedBuffer, element) : to32ByteBuffer(i);
    seedBuffer = seed ? element : seedBuffer;
    elements.push(element);
  }

  return elements;
};

const getNewState = (currentState, arg) => {
  let newState = currentState;

  for (let i= 0; i < 1000; i++) {
    newState = hashNode(newState, arg);
  }

  return newState;
};

const zeroAddress = '0x0000000000000000000000000000000000000000';

contract.only("Optimistic Roll In", accounts => {
  describe("Basic Testing (must be performed in order)", async () => {
    let suspect = accounts[0];
    let accuser = accounts[1];

    let contractInstance = null;
    let bondAmount = null;
    let accuserBondAmount = null;
    let statesTree = null;
    let argsTree = null;
    let fraudulentTransitionIndex = null;
    let lockedBlock = null;
    let rollbackSize = null;
    let fraudulentTxId = null;
    let txIdAfterFraudulentTxId = null;
    let statesPartialTree = null;
    let argsPartialTree = null;

    // The Story
    //  - A user will bond and initialize their account
    //  - This user will perform 1 non-optimistic (on-chain computed) state transition
    //  - This user will perform 1 valid optimistic state transition
    //  - This user will perform 100 valid optimistic state transitions in batch (1 transaction)
    //  - This user (hereby called the suspect) will perform another 100 optimistic state transitions in batch, but inject an invalid transition somewhere in there
    //  - Another user (hereby called the accuser) will be able to detect the fraudulent transition in that transaction
    //  - The accuser uses just the fraudulent transaction's data to build Partial Merkle Trees that can be used to create a fraud proof
    //  - The accuser need to lock the suspect's account for long enough that a fraud proof can be built without the suspect's account roots changing on-chain
    //  - Before the accuser can lock the suspect's account, the suspect performs another valid state transition
    //  - The accuser finally locks the suspect's account, and, to discourage a DOS, the accuser also bond's themselves
    //  - The accuser is able to update their Partial Merkle Trees with the transition data in the suspect's last transaction
    //  - The accuser uses the Partial Merkle Trees to build a fraud proof to demonstrate the exact transition number/index where the fraudulent transition happened
    //  - The suspect is further locked from making transitions until they roll back their account roots
    //  - The contract is therefore aware of the expected size of their account trees, given the above transition number/index
    //  - The accuser is rewarded with the suspect's bond for having proven all of this
    //  - The accuser withdraws their account balance, which is their original bond, plus their reward (the suspect's original bond)
    //  - The suspect constructs new account Merkle Trees of the expected size, and proves to the contract that these are valid prior version of the account trees (Rollback Proof)
    //  - The suspect also re-bonds themselves at the same time as the rollback
    //  - The suspect (now a normal user) carries on to perform 100 valid optimistic state transitions in batch

    before(async () => {
      contractInstance = await Optimistic_Roll_In.new();
    });

    it("can bond a user (who will eventually be the guilty suspect).", async () => {
      bondAmount = '1000000000000000000';
      const { receipt, logs } = await contractInstance.bond(suspect, { value: bondAmount, from: suspect });
      const balance = await contractInstance.balance(suspect);

      expect(receipt.gasUsed).to.equal(44007);

      expect(logs[0].event).to.equal('Bonded');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(bondAmount);

      expect(balance.toString()).to.equal(bondAmount);
    });

    it("can initialize a user (suspect).", async () => {
      // When initialized, the suspect's state tree will state with a zero state element, while their arg tree will have no elements
      const { receipt, logs } = await contractInstance.initialize({ from: suspect });
      statesTree = new MerkleTree([to32ByteBuffer(0)], treeOptions);
      argsTree = new MerkleTree([], treeOptions);
      const statesRoot = await contractInstance.states_root(suspect);
      const argsRoot = await contractInstance.args_root(suspect);

      expect(receipt.gasUsed).to.equal(45101);

      expect(logs[0].event).to.equal('Initialized');
      expect(logs[0].args[0]).to.equal(suspect);

      expect(statesRoot).to.equal('0x' + statesTree.root.toString('hex'));
      expect(argsRoot).to.equal('0x' + argsTree.root.toString('hex'));
    });

    it("allows a user (suspect) to perform a normal state transition.", async () => {
      const arg = generateElements(1, { seed: '44' })[0];
      const argHex = '0x' + arg.toString('hex');
      const transitionIndex = statesTree.elements.length - 1;
      const currentState = statesTree.elements[transitionIndex];
      const currentStateHex = '0x' + currentState.toString('hex');
      const proofOptions = { compact: true };

      // Compute the new state from the current state (which is the last state) and the arg
      const newState = getNewState(currentState, arg);

      // Build the Single Proof, to prove the existence of the last state, that also enables the appending of a new state to the states tree
      const { proof: stateProof, newMerkleTree: newStatesTree } = statesTree.useAndAppend(transitionIndex, newState, proofOptions);
      const { compactProof: stateSingleProof } = stateProof;
      const stateSingleProofHex = stateSingleProof.map(p => '0x' + p.toString('hex'));

      // Build an Append Proof that enables appending a new arg to the args tree
      const { proof: argProof, newMerkleTree: newArgsTree } = argsTree.appendSingle(arg, proofOptions);
      const { compactProof: argAppendProof } = argProof;
      const argAppendProofHex = argAppendProof.map(p => '0x' + p.toString('hex'));

      const { receipt, logs } = await contractInstance.perform(transitionIndex, currentStateHex, argHex, argAppendProofHex, stateSingleProofHex, { from: suspect });
      
      // Since the transaction executed successfully, update the locally maintained merkle trees
      statesTree = newStatesTree;
      argsTree = newArgsTree;

      const newStatesRoot = await contractInstance.states_root(suspect);
      const newArgsRoot = await contractInstance.args_root(suspect);

      expect(receipt.gasUsed).to.equal(289871);

      expect(logs[0].event).to.equal('New_State');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1]).to.equal('0x' + newState.toString('hex'));

      expect(newStatesRoot).to.equal('0x' + statesTree.root.toString('hex'));
      expect(newArgsRoot).to.equal('0x' + argsTree.root.toString('hex'));
    });

    it("allows a user (suspect) to perform a valid optimistic state transition.", async () => {
      const arg = generateElements(1, { seed: '55' })[0];
      const argHex = '0x' + arg.toString('hex');
      const transitionIndex = statesTree.elements.length - 1;
      const currentState = statesTree.elements[transitionIndex];
      const currentStateHex = '0x' + currentState.toString('hex');
      const proofOptions = { compact: true };

      // Compute the new state from the current state (which is the last state) and the arg
      const newState = getNewState(currentState, arg);
      const newStateHex = '0x' + newState.toString('hex');

      // Build the Single Proof, to prove the existence of the last state, that also enables the appending of a new state to the states tree
      const { proof: stateProof, newMerkleTree: newStatesTree } = statesTree.useAndAppend(transitionIndex, newState, proofOptions);
      const { compactProof: stateSingleProof } = stateProof;
      const stateSingleProofHex = stateSingleProof.map(p => '0x' + p.toString('hex'));

      // Build an Append Proof that enables appending a new arg to the args tree
      const { proof: argProof, newMerkleTree: newArgsTree } = argsTree.appendSingle(arg, proofOptions);
      const { compactProof: argAppendProof } = argProof;
      const argAppendProofHex = argAppendProof.map(p => '0x' + p.toString('hex'));

      const { receipt, logs } = await contractInstance.perform_optimistically(transitionIndex, currentStateHex, argHex, newStateHex, argAppendProofHex, stateSingleProofHex, { from: suspect });
      
      // Since the transaction executed successfully, update the locally maintained merkle trees
      statesTree = newStatesTree;
      argsTree = newArgsTree;

      const newStatesRoot = await contractInstance.states_root(suspect);
      const newArgsRoot = await contractInstance.args_root(suspect);

      expect(receipt.gasUsed).to.equal(42733);

      expect(logs[0].event).to.equal('New_Optimistic_State');
      expect(logs[0].args[0]).to.equal(suspect);

      expect(newStatesRoot).to.equal('0x' + statesTree.root.toString('hex'));
      expect(newArgsRoot).to.equal('0x' + argsTree.root.toString('hex'));
    });

    it("allows a user (suspect) to perform valid optimistic state transitions in batch.", async () => {
      const transitions = 100;
      const args = generateElements(transitions, { seed: '66' });
      const argsHex = args.map(a => '0x' + a.toString('hex'));
      const transitionIndex = statesTree.elements.length - 1;
      const currentState = statesTree.elements[transitionIndex];
      const currentStateHex = '0x' + currentState.toString('hex');
      const proofOptions = { compact: true };

      // Compute the new states from the current state (which is the last state) and the args
      const newStates = [];
      
      for (let i = 0; i < transitions; i++) {
        const newState = i === 0
          ? getNewState(currentState, args[i])
          : getNewState(newStates[i - 1], args[i]);

        newStates.push(newState);
      }

      const newStatesHex = newStates.map(s => '0x' + s.toString('hex'));
      
      // Build the Single Proof, to prove the existence of the last state, that also enables the appending of several new states to the states tree
      const { proof: stateProof, newMerkleTree: newStatesTree } = statesTree.useAndAppend(transitionIndex, newStates, proofOptions);
      const { compactProof: stateMultiProof } = stateProof;
      const stateMultiProofHex = stateMultiProof.map(p => '0x' + p.toString('hex'));

      // Build an Append Proof that enables appending new args to the args tree
      const { proof: argProof, newMerkleTree: newArgsTree } = argsTree.appendMulti(args, proofOptions);
      const { compactProof: argAppendProof } = argProof;
      const argAppendProofHex = argAppendProof.map(p => '0x' + p.toString('hex'));

      const { receipt, logs } = await contractInstance.perform_many_optimistically(transitionIndex, currentStateHex, argsHex, newStatesHex, argAppendProofHex, stateMultiProofHex, { from: suspect });
      
      // Since the transaction executed successfully, update the locally maintained merkle trees
      statesTree = newStatesTree;
      argsTree = newArgsTree;

      const newStatesRoot = await contractInstance.states_root(suspect);
      const newArgsRoot = await contractInstance.args_root(suspect);

      expect(receipt.gasUsed).to.equal(289808);

      expect(logs[0].event).to.equal('New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);

      expect(newStatesRoot).to.equal('0x' + statesTree.root.toString('hex'));
      expect(newArgsRoot).to.equal('0x' + argsTree.root.toString('hex'));
    });

    it("allows a user (suspect) to perform fraudulent optimistic state transitions in batch.", async () => {
      const transitions = 100;
      const args = generateElements(transitions, { seed: '66' });
      const argsHex = args.map(a => '0x' + a.toString('hex'));
      const transitionIndex = statesTree.elements.length - 1;
      const currentState = statesTree.elements[transitionIndex];
      const currentStateHex = '0x' + currentState.toString('hex');
      const proofOptions = { compact: true };

      // The 21st state transition (0-indexed) here will be fraudulent (incorrect)
      const fraudulentIndex = 20;

      // Overall, this fraudulent transition is the 122nd transition (1 normal, 100 batch, the 21st is incorrect)
      fraudulentTransitionIndex = transitionIndex + fraudulentIndex;
      const newStates = [];
      
      for (let i = 0; i < transitions; i++) {
        const newState = i === 0
          ? getNewState(currentState, args[i])
          : i === fraudulentIndex
            ? to32ByteBuffer(888888)
            : getNewState(newStates[i - 1], args[i]);

        newStates.push(newState);
      }
      
      const newStatesHex = newStates.map(s => '0x' + s.toString('hex'));

      // Build the Single Proof, to prove the existence of the last state, that also enables the appending of several new states to the states tree
      const { proof: stateProof, newMerkleTree: newStatesTree } = statesTree.useAndAppend(transitionIndex, newStates, proofOptions);
      const { compactProof: stateSingleProof } = stateProof;
      const stateSingleProofHex = stateSingleProof.map(p => '0x' + p.toString('hex'));

      // Build an Append Proof that enables appending new args to the args tree
      const { proof: argProof, newMerkleTree: newArgsTree } = argsTree.appendMulti(args, proofOptions);
      const { compactProof: argAppendProof } = argProof;
      const argAppendProofHex = argAppendProof.map(p => '0x' + p.toString('hex'));

      const { receipt, logs } = await contractInstance.perform_many_optimistically(transitionIndex, currentStateHex, argsHex, newStatesHex, argAppendProofHex, stateSingleProofHex, { from: suspect });
      
      // Since the transaction executed successfully, update the locally maintained merkle trees
      statesTree = newStatesTree;
      argsTree = newArgsTree;

      // Save this txId (for the accuser), simulating that the accuser will see this txId and need to validate it later
      fraudulentTxId = receipt.transactionHash;

      const newStatesRoot = await contractInstance.states_root(suspect);
      const newArgsRoot = await contractInstance.args_root(suspect);

      expect(receipt.gasUsed).to.equal(298186);

      expect(logs[0].event).to.equal('New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);

      expect(newStatesRoot).to.equal('0x' + statesTree.root.toString('hex'));
      expect(newArgsRoot).to.equal('0x' + argsTree.root.toString('hex'));
    });

    it("allows a user (accuser) to detect a transaction containing a fraudulent state transition.", async () => {
      const fnDecoder = new txDecoder.FunctionDecoder(contractABI);

      // Pull the transaction containing the suspected fraudulent transition
      const fraudulentTx = await web3.eth.getTransaction(fraudulentTxId);
      const decodedFraudulentData = fnDecoder.decodeFn(fraudulentTx.input);

      // Decode the input data (calldata) to unpack the args, states, and proofs
      const {
        sighash,
        transition_index: transitionIndexBN,
        current_state: currentStateHex,
        args: argsHex,
        new_states: newStatesHex,
        arg_append_proof: argAppendProofHex,
        state_single_proof: stateSingleProofHex,
      } = decodedFraudulentData;

      // Convert Big Numbers to numbers, and hex strings to Buffers
      const transitionIndex = transitionIndexBN.toNumber();
      const currentState = Buffer.from(currentStateHex.slice(2), 'hex');
      const args = argsHex.map(arg => Buffer.from(arg.slice(2), 'hex'));
      const newStates = newStatesHex.map(newState => Buffer.from(newState.slice(2), 'hex'));
      const argAppendProof = argAppendProofHex.map(proof => Buffer.from(proof.slice(2), 'hex'));
      const stateSingleProof = stateSingleProofHex.map(proof => Buffer.from(proof.slice(2), 'hex'));

      // Compute what the new states should have been, from the original current state (which is the last state) and the args
      const computedNewStates = [];
      let fraudulentIndex = -1;

      for (let i = 0; i < args.length; i++) {
        const newState = i === 0
          ? getNewState(currentState, args[i])
          : getNewState(computedNewStates[i - 1], args[i]);

        computedNewStates.push(newState);

        // If a new state computed does not match what was optimistically provided in the calldata, we found a fraudulent transition
        if (!newState.equals(newStates[i])) {
          fraudulentIndex = i;
          break;
        }
      }

      // Recall that this fraudulent transition should be the 21st (0-indexed) transition in this batch
      expect(fraudulentIndex).to.equals(20);

      // Build a partial merkle tree (for the states) from the proof data pulled from this transaction
      const stateProof = { index: transitionIndex, element: currentState, compactProof: stateSingleProof };
      statesPartialTree = PartialMerkleTree.fromSingleProof(stateProof, treeOptions).append(newStates);
      const statesRoot = await contractInstance.states_root(suspect);
      
      // We expect this partial tree to have the same root as the suspects current states tree on-chain
      expect(statesPartialTree.root.toString('hex')).to.equal(statesRoot.slice(2));

      // Build a partial merkle tree (for the args) from the proof data pulled from this transaction
      const argProof = { appendElements: args, compactProof: argAppendProof };
      argsPartialTree = PartialMerkleTree.fromAppendProof(argProof, treeOptions);
      const argsRoot = await contractInstance.args_root(suspect);

      // We expect this partial tree to have the same root as the suspects current args tree on-chain
      expect(argsPartialTree.root.toString('hex')).to.equal(argsRoot.slice(2));
    });

    it("allows a user (suspect) to perform a valid optimistic state transition on top of an invalid state.", async () => {
      const arg = generateElements(1, { seed: '77' })[0];
      const argHex = '0x' + arg.toString('hex');
      const transitionIndex = statesTree.elements.length - 1;
      const currentState = statesTree.elements[transitionIndex];
      const currentStateHex = '0x' + currentState.toString('hex');
      const proofOptions = { compact: true };

      // Compute the new state from the current state (which is the last state) and the arg
      const newState = getNewState(currentState, arg);
      const newStateHex = '0x' + newState.toString('hex');

      // Build the Single Proof, to prove the existence of the last state, that also enables the appending of a new state to the states tree
      const { proof: stateProof, newMerkleTree: newStatesTree } = statesTree.useAndAppend(transitionIndex, newState, proofOptions);
      const { compactProof: stateSingleProof } = stateProof;
      const stateSingleProofHex = stateSingleProof.map(p => '0x' + p.toString('hex'));

      // Build an Append Proof that enables appending a new arg to the args tree
      const { proof: argProof, newMerkleTree: newArgsTree } = argsTree.appendSingle(arg, proofOptions);
      const { compactProof: argAppendProof } = argProof;
      const argAppendProofHex = argAppendProof.map(p => '0x' + p.toString('hex'));

      const { receipt, logs } = await contractInstance.perform_optimistically(transitionIndex, currentStateHex, argHex, newStateHex, argAppendProofHex, stateSingleProofHex, { from: suspect });
      
      // Since the transaction executed successfully, update the locally maintained merkle trees
      statesTree = newStatesTree;
      argsTree = newArgsTree;

      // Save this txId (for the accuser), simulating that the accuser will see this txId and need to append its contents to their partial tree later
      txIdAfterFraudulentTxId = receipt.transactionHash;

      const newStatesRoot = await contractInstance.states_root(suspect);
      const newArgsRoot = await contractInstance.args_root(suspect);

      expect(receipt.gasUsed).to.equal(50216);

      expect(logs[0].event).to.equal('New_Optimistic_State');
      expect(logs[0].args[0]).to.equal(suspect);

      expect(newStatesRoot).to.equal('0x' + statesTree.root.toString('hex'));
      expect(newArgsRoot).to.equal('0x' + argsTree.root.toString('hex'));
    });

    it("allows a user (accuser) to lock a suspect's account for a time frame.", async () => {
      // An accuser, who previously detected the fraudulent transition will, will lco out the suspect (and bond themselves at the same time)
      accuserBondAmount = '1000000000000000000';
      const { receipt, logs } = await contractInstance.lock_user(suspect, { value: accuserBondAmount, from: accuser });
      lockedBlock = receipt.blockNumber.toString();

      const balance = await contractInstance.balance(accuser);
      const suspectLocker = await contractInstance.locker(suspect);
      const suspectLockedBlock = await contractInstance.locked_block(suspect);
      const accuserLocker = await contractInstance.locker(accuser);
      const accuserLockedBlock = await contractInstance.locked_block(accuser);

      expect(receipt.gasUsed).to.equal(129229);

      expect(logs[0].event).to.equal('Bonded');
      expect(logs[0].args[0]).to.equal(accuser);
      expect(logs[0].args[1].toString()).to.equal(accuserBondAmount);

      expect(logs[1].event).to.equal('Locked');
      expect(logs[1].args[0]).to.equal(suspect);
      expect(logs[1].args[1]).to.equal(accuser);

      expect(balance.toString()).to.equal(accuserBondAmount);

      expect(suspectLocker).to.equal(accuser);
      expect(suspectLockedBlock.toString()).to.equal(lockedBlock);
      expect(accuserLocker).to.equal(accuser);
      expect(accuserLockedBlock.toString()).to.equal(lockedBlock);
    });

    it("allows a user (accuser) to update their local partial tree with the suspect's pre-lockout valid transition.", async () => {
      const fnDecoder = new txDecoder.FunctionDecoder(contractABI);
      
      // Pull the transaction that occurred after the suspected fraudulent transition
      const txAfterFraudulentTx = await web3.eth.getTransaction(txIdAfterFraudulentTxId);
      const decodedValidData = fnDecoder.decodeFn(txAfterFraudulentTx.input);

      // Decode the input data (calldata) to unpack just the arg and state
      // We need these since appending them respectively to each partial tree, that were' going to build, will result in trees
      // that match what is current on chain for the suspect (since we haven't)
      const {
        arg: argHex,
        new_state: newStateHex,
      } = decodedValidData;

      // Convert the hex strings to Buffers
      const arg = Buffer.from(argHex.slice(2), 'hex');
      const newState = Buffer.from(newStateHex.slice(2), 'hex');

      // Append the new state to the locally maintained states partial tree
      statesPartialTree = statesPartialTree.append(newState);
      const statesRoot = await contractInstance.states_root(suspect);
      
      // We expect this partial tree to have the same root as the suspects current states tree on-chain
      expect(statesPartialTree.root.toString('hex')).to.equal(statesRoot.slice(2));

      // Append the new state to the locally maintained args partial tree
      argsPartialTree = argsPartialTree.append(arg);
      const argsRoot = await contractInstance.args_root(suspect);

      // We expect this partial tree to have the same root as the suspects current args tree on-chain
      expect(argsPartialTree.root.toString('hex')).to.equal(argsRoot.slice(2));
    });

    it("allows a user (accuser) to prove a suspect's fraud (from a partial tree).", async () => {
      const transitionIndex = fraudulentTransitionIndex;
      const proofOptions = { compact: true };

      // Build a Single Proof for the arg that was used in this invalid state transition
      const { element: arg, compactProof: argSingleProof } = argsPartialTree.generateSingleProof(transitionIndex, proofOptions);
      const argHex = '0x' + arg.toString('hex');
      const argSingleProofHex = argSingleProof.map(p => '0x' + p.toString('hex'));
      
      // Build a Multi Proof for the current and new state that was provided in this invalid state transition
      const { elements: states, compactProof: statesMultiProof } = statesPartialTree.generateMultiProof([transitionIndex, transitionIndex + 1], proofOptions);
      const statesHex = states.map(s => '0x' + s.toString('hex'));
      const statesMultiProofHex = statesMultiProof.map(p => '0x' + p.toString('hex'));
      
      // Prove the fraud
      const { receipt, logs } = await contractInstance.prove_fraud(suspect, transitionIndex, argHex, statesHex, argSingleProofHex, statesMultiProofHex, { from: accuser });

      const suspectBalance = await contractInstance.balance(suspect);
      const suspectLocker = await contractInstance.locker(suspect);
      const suspectLockedBlock = await contractInstance.locked_block(suspect);
      const suspectRollbackSize = await contractInstance.rollback_size(suspect);

      const accuserBalance = await contractInstance.balance(accuser);
      const accuserLocker = await contractInstance.locker(accuser);
      const accuserLockedBlock = await contractInstance.locked_block(accuser);

      const expectedAccuserBalance = web3.utils.toBN(bondAmount).add(web3.utils.toBN(accuserBondAmount)).toString();
      rollbackSize = (transitionIndex + 1).toString();

      expect(receipt.gasUsed).to.equal(282686);

      expect(logs[0].event).to.equal('Fraud_Proven');
      expect(logs[0].args[0]).to.equal(accuser);
      expect(logs[0].args[1]).to.equal(suspect);
      expect(logs[0].args[2].toString()).to.equal(transitionIndex.toString());
      expect(logs[0].args[3].toString()).to.equal(bondAmount);

      expect(suspectBalance.toString()).to.equal('0');
      expect(suspectLocker).to.equal(suspect);
      expect(suspectLockedBlock.toString()).to.equal('0');
      expect(suspectRollbackSize.toString()).to.equal(rollbackSize);

      expect(accuserBalance.toString()).to.equal(expectedAccuserBalance);
      expect(accuserLocker).to.equal(zeroAddress);
      expect(accuserLockedBlock.toString()).to.equal('0');
    });

    it("allows a user (accuser) to withdraw their balance (including thee reward).", async () => {
      const { receipt, logs } = await contractInstance.withdraw(suspect, { from: accuser });
      const balanceUser0 = await contractInstance.balance(suspect);
      const balanceUser1 = await contractInstance.balance(accuser);

      const expectedWithdrawalAmount = web3.utils.toBN(bondAmount).add(web3.utils.toBN(accuserBondAmount)).toString();

      expect(receipt.gasUsed).to.equal(22659);

      expect(logs[0].event).to.equal('Withdrawal');
      expect(logs[0].args[0]).to.equal(accuser);
      expect(logs[0].args[1]).to.equal(suspect);
      expect(logs[0].args[2].toString()).to.equal(expectedWithdrawalAmount);

      expect(balanceUser0.toString()).to.equal('0');
      expect(balanceUser1.toString()).to.equal('0');
    });
  
    it("allows a user (suspect) to rollback their args tree and states tree.", async () => {
      const proofOptions = { compact: true };
      
      // Suspect needs to create an args Merkle Tree of all pre-invalid-transition args
      // Note: rollbackSize is a bad name. Its really the expected size of the tree after the rollback is performed
      const oldArgs = argsTree.elements.slice(0, rollbackSize - 1);
      const oldArgsTree = new MerkleTree(oldArgs, treeOptions);
      const oldArgsRootHex = '0x' + oldArgsTree.root.toString('hex');

      const rolledBackArgs = argsTree.elements.slice(rollbackSize - 1);
      const rolledBackArgsHex = rolledBackArgs.map(a => '0x' + a.toString('hex'));

      // Suspect needs to build an Append Proof to prove to the contract that the old args root, when appended with the rolled back args,
      // has the root that equals the root of current on-chain args tree
      const { proof: argProof } = oldArgsTree.appendMulti(rolledBackArgs, proofOptions);
      const { compactProof: argAppendProof } = argProof;
      const argAppendProofHex = argAppendProof.map(p => '0x' + p.toString('hex'));

      // Suspect needs to create a states Merkle Tree of all pre-invalid-transition states
      // Note: rollbackSize is a bad name. Its really the expected size of the tree after the rollback is performed
      const oldStates = statesTree.elements.slice(0, rollbackSize);
      const oldStatesTree = new MerkleTree(oldStates, treeOptions);
      const oldStatesRootHex = '0x' + oldStatesTree.root.toString('hex');

      const rolledBackStates = statesTree.elements.slice(rollbackSize);
      const rolledBackStatesHex = rolledBackStates.map(s => '0x' + s.toString('hex'));

      // Suspect needs to build an Append Proof to prove to the contract that the old states root, when appended with the rolled back states,
      // has the root that equals the root of current on-chain states tree
      const { proof: statesProof } = oldStatesTree.appendMulti(rolledBackStates, proofOptions);
      const { compactProof: statesAppendProof } = statesProof;
      const statesAppendProofHex = statesAppendProof.map(p => '0x' + p.toString('hex'));

      // Suspect performs the rollback while bonding new coin at the same time
      const { receipt, logs } = await contractInstance.rollback(oldArgsRootHex, oldStatesRootHex, rolledBackArgsHex, rolledBackStatesHex, argAppendProofHex, statesAppendProofHex, { value: bondAmount, from: suspect });
      
      // Since the rollback transaction was successful, update the locally maintained states and args trees
      statesTree = oldStatesTree;
      argsTree = oldArgsTree;
      
      const suspectBalance = await contractInstance.balance(suspect);
      const suspectLocker = await contractInstance.locker(suspect);
      const suspectRollbackSize = await contractInstance.rollback_size(suspect);
      const argsRoot = await contractInstance.args_root(suspect);
      const statesRoot = await contractInstance.states_root(suspect);

      expect(receipt.gasUsed).to.equal(255721);

      expect(logs[0].event).to.equal('Bonded');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(bondAmount);

      expect(logs[1].event).to.equal('Rolled_Back');
      expect(logs[1].args[0]).to.equal(suspect);
      expect(logs[1].args[1].toString()).to.equal(fraudulentTransitionIndex.toString());

      expect(suspectBalance.toString()).to.equal(bondAmount);
      expect(suspectLocker).to.equal(zeroAddress);
      expect(suspectRollbackSize.toString()).to.equal('0');

      expect(argsRoot).to.equal(oldArgsRootHex);
      expect(statesRoot).to.equal(oldStatesRootHex);
    });

    it("allows a user (suspect) to re-perform valid optimistic state transitions in batch.", async () => {
      const transitions = 100;
      const args = generateElements(transitions, { seed: '66' });
      const argsHex = args.map(a => '0x' + a.toString('hex'));
      const transitionIndex = statesTree.elements.length - 1;
      const currentState = statesTree.elements[transitionIndex];
      const currentStateHex = '0x' + currentState.toString('hex');
      const proofOptions = { compact: true };

      // Compute the new states from the current state (which is the last state) and the args
      const newStates = [];
      
      for (let i = 0; i < transitions; i++) {
        const newState = i === 0
          ? getNewState(currentState, args[i])
          : getNewState(newStates[i - 1], args[i]);

        newStates.push(newState);
      }
      
      const newStatesHex = newStates.map(s => '0x' + s.toString('hex'));
      
      // Build the Single Proof, to prove the existence of the last state, that also enables the appending of several new states to the states tree
      const { proof: stateProof, newMerkleTree: newStatesTree } = statesTree.useAndAppend(transitionIndex, newStates, proofOptions);
      const { compactProof: stateMultiProof } = stateProof;
      const stateMultiProofHex = stateMultiProof.map(p => '0x' + p.toString('hex'));

      const { proof: argProof, newMerkleTree: newArgsTree } = argsTree.appendMulti(args, proofOptions);
      const { compactProof: argAppendProof } = argProof;
      const argAppendProofHex = argAppendProof.map(p => '0x' + p.toString('hex'));

      // Build an Append Proof that enables appending new args to the args tree
      const { receipt, logs } = await contractInstance.perform_many_optimistically(transitionIndex, currentStateHex, argsHex, newStatesHex, argAppendProofHex, stateMultiProofHex, { from: suspect });
      
      // Since the transaction executed successfully, update the locally maintained merkle trees
      statesTree = newStatesTree;
      argsTree = newArgsTree;

      const newStatesRoot = await contractInstance.states_root(suspect);
      const newArgsRoot = await contractInstance.args_root(suspect);

      expect(receipt.gasUsed).to.equal(300474);

      expect(logs[0].event).to.equal('New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);

      expect(newStatesRoot).to.equal('0x' + statesTree.root.toString('hex'));
      expect(newArgsRoot).to.equal('0x' + argsTree.root.toString('hex'));
    });
  });
});
