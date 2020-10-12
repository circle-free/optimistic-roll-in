const chai = require('chai');
const { expect } = chai;
const { Keccak } = require('sha3');
const crypto = require('crypto');
const { MerkleTree, PartialMerkleTree } = require('merkle-trees/js');
const txDecoder = require('ethereum-tx-decoder');
const { abi: optimismABI } = require('../build/contracts/Optimistic_Roll_In.json');
const { abi: logicABI } = require('../build/contracts/Some_Logic_Contract.json');

const OptimisticRollIn = artifacts.require("Optimistic_Roll_In");
const SomeLogicContract = artifacts.require("Some_Logic_Contract");

const treeOptions = {
  unbalanced: true,
  sortedHash: false,
  elementPrefix: '00',
};

const leftPad = (num, size, char = '0') => {
  let s = num + '';

  while (s.length < size) s = char + s;

  return s;
};

const to32ByteBuffer = (number) => Buffer.from(leftPad(number.toString(16), 64), 'hex');

const hash = (buffer) => new Keccak(256).update(buffer).digest();

const hashPacked = (buffers) => hash(Buffer.concat(buffers));

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

const advanceTime = (time) => {
  return new Promise((resolve, reject) => {
    web3.currentProvider.send({
      jsonrpc: '2.0',
      method: 'evm_increaseTime',
      params: [time],
      id: new Date().getTime()
    }, (err, result) => {
      if (err) return reject(err);

      return resolve(result);
    })
  });
}

const initialStateSelector = '0x1e58e625';
const zeroAddress = '0x0000000000000000000000000000000000000000';

contract("Optimistic Roll In", accounts => {
  describe("Basic Testing (must be performed in order)", async () => {
    let suspect = accounts[0];
    let accuser = accounts[1];

    let logicContractInstance = null;
    let logicAddress = null;
    let contractInstance = null;
    let bondAmount = null;
    let callDataTree = null;
    let currentState = null;
    let lastTime = null;
    let fraudulentTransitionIndex = null;
    let fraudulentTxId = null;
    let callDataPartialTree = null;
    let txIdAfterFraudulentTxId = null;
    let accuserBondAmount = null;

    // The Story
    //  - A user will bond and initialize their account
    //  - This user will perform 1 non-optimistic (on-chain computed) state transition (and remain outside of optimism)
    //  - This user will perform 1 valid optimistic state transition to enter optimistic state
    //  - This user will perform 1 valid optimistic state transition
    //  - This user will perform 100 valid optimistic state transitions in batch (1 transaction)
    //  - This user (hereby called the suspect) will perform another 100 optimistic state transitions in batch, but inject an invalid transition somewhere in there
    //  - Another user (hereby called the accuser) will be able to detect the fraudulent transition in that transaction
    //  - The accuser uses just the fraudulent transaction's data to build a Partial Merkle Tree that can be used to create a fraud proof
    //  - The accuser need to lock the suspect's account for long enough that a fraud proof can be built without the suspect's account roots changing on-chain
    //  - Before the accuser can lock the suspect's account, the suspect performs another valid state transition
    //  - The accuser finally locks the suspect's account, and, to discourage a DOS, the accuser also bond's themselves
    //  - The accuser is able to update their Partial Merkle Tree with the transition data in the suspect's last transaction
    //  - The accuser uses the Partial Merkle Tree to build a fraud proof to demonstrate the exact transition that was fraudulent
    //  - The suspect is further locked from making transitions until they roll back their account roots
    //  - The contract is therefore aware of the expected post-roll-back size of their call data tree
    //  - The accuser is rewarded with the suspect's bond for having proven all of this
    //  - The accuser withdraws their account balance, which is their original bond, plus their reward (the suspect's original bond)
    //  - The suspect constructs a new call data Merkle Tree of the expected size, and proves to the contract that it's valid prior version of the call data tree (Rollback Proof)
    //  - The suspect also re-bonds themselves at the same time as the rollback
    //  - The suspect (now a normal user) carries on to perform 100 valid optimistic state transitions in batch
    //  - This user will perform 1 non-optimistic (on-chain computed) state transition to exit optimism
    //  - This user will perform 50 optimistic valid optimistic state transitions in batch to reenter optimism

    before(async () => {
      logicContractInstance = await SomeLogicContract.new();
      logicAddress = logicContractInstance.address;
      contractInstance = await OptimisticRollIn.new(logicAddress, initialStateSelector);
    });

    it("can bond a user (who will eventually be the guilty suspect).", async () => {
      bondAmount = '1000000000000000000';
      const { receipt, logs } = await contractInstance.bond(suspect, { value: bondAmount, from: suspect });
      const balance = await contractInstance.balances(suspect);

      expect(balance.toString()).to.equal(bondAmount);
      expect(receipt.gasUsed).to.equal(42706);
    });

    it("can initialize a user (suspect).", async () => {
      // When initialized, the suspect's account state will be an initial state, empty call data tree, and the last optimistic time will be 0
      const { receipt, logs } = await contractInstance.initialize({ from: suspect });
      callDataTree = new MerkleTree([], treeOptions);
      currentState = to32ByteBuffer(0);
      lastTime = 0; 

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);
      const expectedAccountStateHex = '0x' + expectedAccountState.toString('hex');

      expect(accountState).to.equal(expectedAccountStateHex);

      expect(logs[0].event).to.equal('Initialized');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal('0x' + currentState.toString('hex'));

      expect(receipt.gasUsed).to.equal(46492);
    });

    it("allows a user (suspect) to perform a normal state transition (and remain outside of optimism).", async () => {
      const arg = generateElements(1, { seed: '44' })[0];
      const argHex = '0x' + arg.toString('hex');
      const currentStateHex = '0x' + currentState.toString('hex');

      // Get the call logic contract address and call data from a logic request
      const { data: callDataHex } = await logicContractInstance.some_pure_transition.request(
        currentStateHex,
        argHex,
        { from: suspect }
      );

      const { receipt, logs } = await contractInstance.perform(
        callDataHex,
        { from: suspect }
      );

      // Compute the new state from the current state (which is the last state) and the arg
      currentState = getNewState(currentState, arg);

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);
      const expectedAccountStateHex = '0x' + expectedAccountState.toString('hex');

      expect(accountState).to.equal(expectedAccountStateHex);
      expect(receipt.gasUsed).to.equal(286269);
    });

    it("allows a user (suspect) to perform a valid optimistic state transition (and enter optimism).", async () => {
      const arg = generateElements(1, { seed: '55' })[0];
      const argHex = '0x' + arg.toString('hex');
      const currentStateHex = '0x' + currentState.toString('hex');
      const proofOptions = { compact: true };

      // Compute the new state from the current state (which is the last state) and the arg
      const newState = getNewState(currentState, arg);
      const newStateHex = '0x' + newState.toString('hex');

      // Get the call logic contract address and call data from a logic request
      const { data: callDataHex } = await logicContractInstance.some_pure_transition.request(
        currentStateHex,
        argHex,
        { from: suspect }
      );
      
      const callData = Buffer.from(callDataHex.slice(2), 'hex');

      // Get the expect new call data tree and append proof
      const { proof, newMerkleTree } = callDataTree.appendSingle(callData, proofOptions);
      const { compactProof: appendProof } = proof;
      const proofHex = appendProof.map(p => '0x' + p.toString('hex'));

      const { receipt, logs } = await contractInstance.perform_optimistically_and_enter(
        callDataHex,
        newStateHex,
        proofHex,
        { from: suspect }
      );
      
      // Since the transaction executed successfully, update the locally maintained variables
      const block = await web3.eth.getBlock(receipt.blockNumber);
      lastTime = block.timestamp;
      callDataTree = newMerkleTree;
      currentState = newState;

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);

      expect(logs[0].event).to.equal('New_Optimistic_State');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(lastTime.toString());

      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));

      expect(receipt.gasUsed).to.equal(33886);
    });

    it("allows a user (suspect) to perform a valid optimistic state transition.", async () => {
      const arg = generateElements(1, { seed: '66' })[0];
      const argHex = '0x' + arg.toString('hex');
      const currentStateHex = '0x' + currentState.toString('hex');
      const proofOptions = { compact: true };

      // Compute the new state from the current state (which is the last state) and the arg
      const newState = getNewState(currentState, arg);
      const newStateHex = '0x' + newState.toString('hex');

      // Get the call logic contract address and call data from a logic request
      const { data: callDataHex } = await logicContractInstance.some_pure_transition.request(
        currentStateHex,
        argHex,
        { from: suspect }
      );
      
      const callData = Buffer.from(callDataHex.slice(2), 'hex');

      // Build an Append Proof that enables appending a new call data to the call data tree
      const { proof, newMerkleTree } = callDataTree.appendSingle(callData, proofOptions);
      const { compactProof: appendProof } = proof;
      const proofHex = appendProof.map(p => '0x' + p.toString('hex'));

      const callDataRootHex = '0x' + callDataTree.root.toString('hex');

      const { receipt, logs } = await contractInstance.perform_optimistically(
        callDataHex,
        newStateHex,
        callDataRootHex,
        proofHex,
        lastTime,
        { from: suspect }
      );

      // Since the transaction executed successfully, update the locally maintained variables
      const block = await web3.eth.getBlock(receipt.blockNumber);
      lastTime = block.timestamp;
      callDataTree = newMerkleTree;
      currentState = newState;

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);

      expect(logs[0].event).to.equal('New_Optimistic_State');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(lastTime.toString());

      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));

      expect(receipt.gasUsed).to.equal(35730);
    });

    it("allows a user (suspect) to perform valid optimistic state transitions in batch.", async () => {
      const transitions = 100;
      const args = generateElements(transitions, { seed: '77' });
      const argsHex = args.map(a => '0x' + a.toString('hex'));
      const proofOptions = { compact: true };

      // Compute the new states from the current state (which is the last state) and the args
      const callDataArray = [];
      let interimState = currentState;
      
      for (let i = 0; i < transitions; i++) {
        const interimStateHex = '0x' + interimState.toString('hex');

        // Get the call data from a logic request
        const { data: callDataHex } = await logicContractInstance.some_pure_transition.request(
          interimStateHex,
          argsHex[i],
          { from: suspect }
        );
        
        // Append call data to array, and update interim state
        const callData = Buffer.from(callDataHex.slice(2), 'hex');
        callDataArray.push(callData);
        interimState = getNewState(interimState, args[i]);
      }

      const callDataArrayHex = callDataArray.map(c => '0x' + c.toString('hex'));
      const newStateHex = '0x' + interimState.toString('hex');
      const callDataRootHex = '0x' + callDataTree.root.toString('hex');

      // Build an Append Proof that enables appending new call data to the call data tree
      const { proof, newMerkleTree } = callDataTree.appendMulti(callDataArray, proofOptions);
      const { compactProof: appendProof } = proof;
      const proofHex = appendProof.map(p => '0x' + p.toString('hex'));

      const { receipt, logs } = await contractInstance.perform_many_optimistically(
        callDataArrayHex,
        newStateHex,
        callDataRootHex,
        proofHex,
        lastTime,
        { from: suspect }
      );

      // Since the transaction executed successfully, update the locally maintained variables
      const block = await web3.eth.getBlock(receipt.blockNumber);
      lastTime = block.timestamp;
      callDataTree = newMerkleTree;
      currentState = interimState;

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);

      expect(logs[0].event).to.equal('New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(lastTime.toString());

      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));

      expect(receipt.gasUsed).to.equal(286126);
    });

    it("allows a user (suspect) to perform fraudulent optimistic state transitions in batch.", async () => {
      const transitions = 100;
      const args = generateElements(transitions, { seed: '88' });
      const argsHex = args.map(a => '0x' + a.toString('hex'));
      const proofOptions = { compact: true };
      const fraudulentIndex = 20;
      fraudulentTransitionIndex = callDataTree.elements.length + fraudulentIndex;

      // Compute the new states from the current state (which is the last state) and the args
      const callDataArray = [];
      let interimState = currentState;
      
      for (let i = 0; i < transitions; i++) {
        const interimStateHex = '0x' + interimState.toString('hex');

        // Get the call data from a logic request
        const { data: callDataHex } = await logicContractInstance.some_pure_transition.request(
          interimStateHex,
          argsHex[i],
          { from: suspect }
        );
        
        // Append call data to array, and update interim state
        const callData = Buffer.from(callDataHex.slice(2), 'hex');
        callDataArray.push(callData);
        
        // Slip in an incorrect state transition 
        interimState = i !== fraudulentIndex
          ? getNewState(interimState, args[i])
          : to32ByteBuffer(1337);
      }

      const callDataArrayHex = callDataArray.map(c => '0x' + c.toString('hex'));
      const newStateHex = '0x' + interimState.toString('hex');
      const callDataRootHex = '0x' + callDataTree.root.toString('hex');

      // Build an Append Proof that enables appending new call data to the call data tree
      const { proof, newMerkleTree } = callDataTree.appendMulti(callDataArray, proofOptions);
      const { compactProof: appendProof } = proof;
      const proofHex = appendProof.map(p => '0x' + p.toString('hex'));

      const { receipt, logs } = await contractInstance.perform_many_optimistically(
        callDataArrayHex,
        newStateHex,
        callDataRootHex,
        proofHex,
        lastTime,
        { from: suspect }
      );

      // Since the transaction executed successfully, update the locally maintained variables
      const block = await web3.eth.getBlock(receipt.blockNumber);
      lastTime = block.timestamp;
      callDataTree = newMerkleTree;
      currentState = interimState;
      fraudulentTxId = receipt.transactionHash;

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);

      expect(logs[0].event).to.equal('New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(lastTime.toString());

      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));

      expect(receipt.gasUsed).to.equal(289085);
    });

    it("allows a user (accuser) to immediately detect a transaction containing a fraudulent state transition.", async () => {
      const optimismDecoder = new txDecoder.FunctionDecoder(optimismABI);
      const logicDecoder = new txDecoder.FunctionDecoder(logicABI);

      // Pull the transaction containing the suspected fraudulent transition
      const fraudulentTx = await web3.eth.getTransaction(fraudulentTxId);
      const decodedOptimismData = optimismDecoder.decodeFn(fraudulentTx.input);

      // Pull the transaction receipt containing the suspected fraudulent transition's logs, and last time
      const fraudulentTxReceipt = await web3.eth.getTransactionReceipt(fraudulentTxId);
      const lastTimeHex = fraudulentTxReceipt.logs[0].topics[2];

      // Pull the transaction receipt of the suspected fraudulent transition, to get the new last time
      // Note: I don't feel like parsing logs, so just pull the timestamp from the block itself
      const block = await web3.eth.getBlock(fraudulentTx.blockNumber);

      // Decode the optimism input data
      const {
        sighash: optimismSig,
        call_data: callDataArrayHex,
        new_state: newStateHex,
        call_data_root: callDataRootHex,
        proof: proofHex,
        last_time: lastTime,
      } = decodedOptimismData;

      // Convert Big Numbers to numbers, and hex strings to Buffers
      const callDataArray = callDataArrayHex.map(c => Buffer.from(c.slice(2), 'hex'));
      const newState = Buffer.from(newStateHex.slice(2), 'hex');
      const callDataRoot = Buffer.from(callDataRootHex.slice(2), 'hex');
      const proof = proofHex.map(p => Buffer.from(p.slice(2), 'hex'));

      // Compute what the new states should have been, from the original current state (which is the last state) and the args
      for (let i = 0; i < callDataArrayHex.length; i++) {
        // Decode arg from calldata and compute expected new state
        const { current_state: startingStateHex, arg: argHex } = logicDecoder.decodeFn(callDataArrayHex[i]);
        const startingState = Buffer.from(startingStateHex.slice(2), 'hex');
        const arg = Buffer.from(argHex.slice(2), 'hex');
        const endState = getNewState(startingState, arg);

        // Get the provided new state for this transition (final or from next call data)
        const providedEndState = (i === callDataArrayHex.length - 1)
          ? newState
          : Buffer.from(logicDecoder.decodeFn(callDataArrayHex[i + 1]).current_state.slice(2), 'hex');

        // Fraudulent if the new state computed does not match what was optimistically provided
        if (!endState.equals(providedEndState)) {
          // Recall that this fraudulent transition should be the 21st (0-indexed) transition in this batch
          expect(i).to.equals(20);
        }
      }

      // Build a partial merkle tree (for the call data) from the proof data pulled from this transaction
      const appendProof = { appendElements: callDataArray, compactProof: proof };
      callDataPartialTree = PartialMerkleTree.fromAppendProof(appendProof, treeOptions);

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataPartialTree.root, newState, Buffer.from(lastTimeHex.slice(2), 'hex')]);

      // We expect this partial tree roots, when combined, to have the same root as the suspects combined trees on-chain
      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));
    });

    it("allows a user (suspect) to perform a valid optimistic state transition on top of an invalid state.", async () => {
      const arg = generateElements(1, { seed: '99' })[0];
      const argHex = '0x' + arg.toString('hex');
      const currentStateHex = '0x' + currentState.toString('hex');
      const proofOptions = { compact: true };

      // Compute the new state from the current state (which is the last state) and the arg
      const newState = getNewState(currentState, arg);
      const newStateHex = '0x' + newState.toString('hex');

      // Get the call logic contract address and call data from a logic request
      const { data: callDataHex } = await logicContractInstance.some_pure_transition.request(
        currentStateHex,
        argHex,
        { from: suspect }
      );
      
      const callData = Buffer.from(callDataHex.slice(2), 'hex');

      // Build an Append Proof that enables appending a new call data to the call data tree
      const { proof, newMerkleTree } = callDataTree.appendSingle(callData, proofOptions);
      const { compactProof: appendProof } = proof;
      const proofHex = appendProof.map(p => '0x' + p.toString('hex'));

      const callDataRootHex = '0x' + callDataTree.root.toString('hex');

      const { receipt, logs } = await contractInstance.perform_optimistically(
        callDataHex,
        newStateHex,
        callDataRootHex,
        proofHex,
        lastTime,
        { from: suspect }
      );

      // Since the transaction executed successfully, update the locally maintained variables
      const block = await web3.eth.getBlock(receipt.blockNumber);
      lastTime = block.timestamp;
      callDataTree = newMerkleTree;
      currentState = newState;
      txIdAfterFraudulentTxId = receipt.transactionHash;

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);

      expect(logs[0].event).to.equal('New_Optimistic_State');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(lastTime.toString());

      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));

      expect(receipt.gasUsed).to.equal(38187);
    });

    it("allows a user (accuser) to lock a suspect's account for a time frame.", async () => {
      // An accuser, who previously detected the fraudulent transition will, will lco out the suspect (and bond themselves at the same time)
      accuserBondAmount = '1000000000000000000';
      const { receipt, logs } = await contractInstance.lock_user(suspect, { value: accuserBondAmount, from: accuser });

      const block = await web3.eth.getBlock(receipt.blockNumber);
      const balance = await contractInstance.balances(accuser);
      const suspectLocker = await contractInstance.lockers(suspect);
      const suspectLockedTime = await contractInstance.locked_times(suspect);
      const accuserLocker = await contractInstance.lockers(accuser);
      const accuserLockedTime = await contractInstance.locked_times(accuser);

      expect(logs[0].event).to.equal('Locked');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1]).to.equal(accuser);

      expect(balance.toString()).to.equal(accuserBondAmount);

      expect(suspectLocker).to.equal(accuser);
      expect(suspectLockedTime.toString()).to.equal(block.timestamp.toString());
      expect(accuserLocker).to.equal(accuser);
      expect(accuserLockedTime.toString()).to.equal(block.timestamp.toString());

      expect(receipt.gasUsed).to.equal(128023);
    });

    it("allows a user (accuser) to update their local partial tree with the suspect's pre-lockout valid transition.", async () => {
      const optimismDecoder = new txDecoder.FunctionDecoder(optimismABI);
      const logicDecoder = new txDecoder.FunctionDecoder(logicABI);
      
      // Pull the transaction that occurred after the suspected fraudulent transition
      const txAfterFraudulentTx = await web3.eth.getTransaction(txIdAfterFraudulentTxId);
      const decodedOptimismData = optimismDecoder.decodeFn(txAfterFraudulentTx.input);

      // Pull the transaction receipt containing the suspected fraudulent transition's logs, and last time
      const receiptAfterFraudulentTx = await web3.eth.getTransactionReceipt(txIdAfterFraudulentTxId);
      const lastTimeHex = receiptAfterFraudulentTx.logs[0].topics[2];

      // Decode the optimism input data
      const {
        sighash: optimismSig,
        call_data: callDataHex,
        new_state: newStateHex,
        call_data_root: callDataRootHex,
        proof: proofHex,
        last_time: lastTime,
      } = decodedOptimismData;

      // Convert the hex strings to Buffers
      const callData = Buffer.from(callDataHex.slice(2), 'hex');
      const newState = Buffer.from(newStateHex.slice(2), 'hex');
      const callDataRoot = Buffer.from(callDataRootHex.slice(2), 'hex');

      // Expect the call data root provided to match that of the local partial tree maintained
      expect(callDataRoot.equals(callDataPartialTree.root)).to.be.true;

      // Check that this last transition was valid, by decoding arg from calldata and compute expected new state
      const { current_state: startingStateHex, arg: argHex } = logicDecoder.decodeFn(callDataHex);
      const startingState = Buffer.from(startingStateHex.slice(2), 'hex');
      const arg = Buffer.from(argHex.slice(2), 'hex');
      const endState = getNewState(startingState, arg);

      // Given this test story, we know this transition is valid
      expect(endState.equals(newState)).to.be.true;

      // Append the new call data to the locally maintained call data partial tree
      callDataPartialTree = callDataPartialTree.append(callData);

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataPartialTree.root, newState, Buffer.from(lastTimeHex.slice(2), 'hex')]);

      // We expect this partial tree roots, when combined, to have the same root as the suspects combined trees on-chain
      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));
    });

    it("allows a user (accuser) to prove a suspect's fraud (from a partial tree).", async () => {
      const proofOptions = { compact: true };

      // Build a Multi Proof for the call data of the fraudulent transition
      const indices = [fraudulentTransitionIndex, fraudulentTransitionIndex + 1];
      const { root, elements, compactProof } = callDataPartialTree.generateMultiProof(indices, proofOptions);
      const callDataArrayHex = elements.map(c => '0x' + c.toString('hex'));
      const proofHex = compactProof.map(p => '0x' + p.toString('hex'));
      const stateHex = '0x' + currentState.toString('hex');
      const callDataRootHex = '0x' + root.toString('hex');
      
      // Prove the fraud
      const { receipt, logs } = await contractInstance.prove_fraud(
        suspect,
        callDataArrayHex,
        stateHex,
        callDataRootHex,
        proofHex,
        lastTime,
        { from: accuser }
      );

      const suspectBalance = await contractInstance.balances(suspect);
      const suspectLocker = await contractInstance.lockers(suspect);
      const suspectLockedTime = await contractInstance.locked_times(suspect);
      const suspectRollbackSize = await contractInstance.rollback_sizes(suspect);

      const accuserBalance = await contractInstance.balances(accuser);
      const accuserLocker = await contractInstance.lockers(accuser);
      const accuserLockedTime = await contractInstance.locked_times(accuser);

      const expectedAccuserBalance = web3.utils.toBN(bondAmount).add(web3.utils.toBN(accuserBondAmount)).toString();

      expect(logs[0].event).to.equal('Fraud_Proven');
      expect(logs[0].args[0]).to.equal(accuser);
      expect(logs[0].args[1]).to.equal(suspect);
      expect(logs[0].args[2].toString()).to.equal(fraudulentTransitionIndex.toString());
      expect(logs[0].args[3].toString()).to.equal(bondAmount);

      expect(suspectBalance.toString()).to.equal('0');
      expect(suspectLocker).to.equal(suspect);
      expect(suspectLockedTime.toString()).to.equal('0');
      expect(suspectRollbackSize.toString()).to.equal(fraudulentTransitionIndex.toString());

      expect(accuserBalance.toString()).to.equal(expectedAccuserBalance);
      expect(accuserLocker).to.equal(zeroAddress);
      expect(accuserLockedTime.toString()).to.equal('0');

      expect(receipt.gasUsed).to.equal(298471);
    });

    it("allows a user (accuser) to withdraw their balance (including the reward).", async () => {
      const { receipt } = await contractInstance.withdraw(suspect, { from: accuser });
      const balanceUser0 = await contractInstance.balances(suspect);
      const balanceUser1 = await contractInstance.balances(accuser);

      expect(receipt.gasUsed).to.equal(21058);
      expect(balanceUser0.toString()).to.equal('0');
      expect(balanceUser1.toString()).to.equal('0');
    });
  
    it("allows a user (suspect) to rollback their call data tree.", async () => {
      const currentStateHex = '0x' + currentState.toString('hex');
      const proofOptions = { compact: true };
      
      // Suspect needs to create a call data Merkle Tree of all pre-invalid-transition call data
      // Note: rollbackSize is a bad name. Its really the expected size of the tree after the rollback is performed
      const oldCallData = callDataTree.elements.slice(0, fraudulentTransitionIndex);
      const rolledBackCallDataTree = new MerkleTree(oldCallData, treeOptions);
      const rolledBackCallDataRootHex = '0x' + rolledBackCallDataTree.root.toString('hex');

      const rolledBackCallDataArray = callDataTree.elements.slice(fraudulentTransitionIndex);
      const rolledBackCallDataArrayHex = rolledBackCallDataArray.map(c => '0x' + c.toString('hex'));

      // Suspect needs to build an Append Proof to prove that the old call data root, when appended with the rolled call data,
      // has the root that equals the root of current on-chain call data tree
      const { proof } = rolledBackCallDataTree.appendMulti(rolledBackCallDataArray, proofOptions);
      const { compactProof: appendProof } = proof;
      const rollBackProofHex = appendProof.map(p => '0x' + p.toString('hex'));

      // Suspect needs to prove to the current size of the on-chain call data tree
      const { root, elementCount: currentSize, elementRoot: sizeProof } = callDataTree.generateSizeProof({ simple: true });
      const callDataRootHex = '0x' + root.toString('hex');
      const currentSizeProofHex = '0x' + sizeProof.toString('hex');

      // Suspect performs the rollback while bonding new coin at the same time
      const { receipt, logs } = await contractInstance.rollback(
        rolledBackCallDataRootHex,
        rolledBackCallDataArrayHex,
        rollBackProofHex,
        currentSize,
        currentSizeProofHex,
        callDataRootHex,
        currentStateHex,
        lastTime,
        { value: bondAmount, from: suspect }
      );

      // Since the transaction executed successfully, update the locally maintained variables
      const block = await web3.eth.getBlock(receipt.blockNumber);
      lastTime = block.timestamp;
      callDataTree = rolledBackCallDataTree;
      currentState = rolledBackCallDataArray[0].slice(4, 36);
      fraudulentTransitionIndex = null;

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);

      const suspectBalance = await contractInstance.balances(suspect);
      const suspectLocker = await contractInstance.lockers(suspect);
      const suspectRollbackSize = await contractInstance.rollback_sizes(suspect);

      expect(logs[0].event).to.equal('Rolled_Back');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(callDataTree.elements.length.toString());
      expect(logs[0].args[2].toString()).to.equal(lastTime.toString());

      expect(suspectBalance.toString()).to.equal(bondAmount);
      expect(suspectLocker).to.equal(zeroAddress);
      expect(suspectRollbackSize.toString()).to.equal('0');

      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));

      expect(receipt.gasUsed).to.equal(246897);
    });

    it("allows a user (suspect) to re-perform valid optimistic state transitions in batch.", async () => {
      const transitions = 100;
      const args = generateElements(transitions, { seed: '88' });
      const argsHex = args.map(a => '0x' + a.toString('hex'));
      const proofOptions = { compact: true };

      // Compute the new states from the current state (which is the last state) and the args
      const callDataArray = [];
      let interimState = currentState;
      
      for (let i = 0; i < transitions; i++) {
        const interimStateHex = '0x' + interimState.toString('hex');

        // Get the call data from a logic request
        const { data: callDataHex } = await logicContractInstance.some_pure_transition.request(
          interimStateHex,
          argsHex[i],
          { from: suspect }
        );
        
        // Append call data to array, and update interim state
        const callData = Buffer.from(callDataHex.slice(2), 'hex');
        callDataArray.push(callData);
        interimState = getNewState(interimState, args[i]);
      }

      const callDataArrayHex = callDataArray.map(c => '0x' + c.toString('hex'));
      const newStateHex = '0x' + interimState.toString('hex');
      const callDataRootHex = '0x' + callDataTree.root.toString('hex');

      // Build an Append Proof that enables appending new call data to the call data tree
      const { proof, newMerkleTree } = callDataTree.appendMulti(callDataArray, proofOptions);
      const { compactProof: appendProof } = proof;
      const proofHex = appendProof.map(p => '0x' + p.toString('hex'));

      const { receipt, logs } = await contractInstance.perform_many_optimistically(
        callDataArrayHex,
        newStateHex,
        callDataRootHex,
        proofHex,
        lastTime,
        { from: suspect }
      );

      // Since the transaction executed successfully, update the locally maintained variables
      const block = await web3.eth.getBlock(receipt.blockNumber);
      lastTime = block.timestamp;
      callDataTree = newMerkleTree;
      currentState = interimState;

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);

      expect(logs[0].event).to.equal('New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(lastTime.toString());

      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));

      expect(receipt.gasUsed).to.equal(290349);
    });

    it("allows a user (suspect) to perform a normal state transition (and exit optimism).", async () => {
      // Need to increase time by at least 600 seconds for this to be allowed
      await advanceTime(lastTime + 700);
      
      const arg = generateElements(1, { seed: '99' })[0];
      const argHex = '0x' + arg.toString('hex');
      const currentStateHex = '0x' + currentState.toString('hex');
      
      // Get the call logic contract address and call data from a logic request
      const { data: callDataHex } = await logicContractInstance.some_pure_transition.request(
        currentStateHex,
        argHex,
        { from: suspect }
      );

      const callDataRootHex = '0x' + callDataTree.root.toString('hex');

      const { receipt, logs } = await contractInstance.perform_and_exit(
        callDataHex,
        callDataRootHex,
        lastTime,
        { from: suspect }
      );

      // Since the transaction executed successfully, update the locally maintained variables
      lastTime = 0;
      callDataTree = new MerkleTree([], treeOptions);
      currentState = getNewState(currentState, arg);

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);
      const expectedAccountStateHex = '0x' + expectedAccountState.toString('hex');

      expect(accountState).to.equal(expectedAccountStateHex);

      expect(logs[0].event).to.equal('Exited_Optimism');
      expect(logs[0].args[0]).to.equal(suspect);

      expect(receipt.gasUsed).to.equal(289446);
    });

    it("allows a user (suspect) to perform valid optimistic state transitions in batch (and reenter optimism).", async () => {
      const transitions = 100;
      const args = generateElements(transitions, { seed: 'aa' });
      const argsHex = args.map(a => '0x' + a.toString('hex'));
      const proofOptions = { compact: true };

      // Compute the new states from the current state (which is the last state) and the args
      const callDataArray = [];
      let interimState = currentState;
      
      for (let i = 0; i < transitions; i++) {
        const interimStateHex = '0x' + interimState.toString('hex');

        // Get the call data from a logic request
        const { data: callDataHex } = await logicContractInstance.some_pure_transition.request(
          interimStateHex,
          argsHex[i],
          { from: suspect }
        );
        
        // Append call data to array, and update interim state
        const callData = Buffer.from(callDataHex.slice(2), 'hex');
        callDataArray.push(callData);
        interimState = getNewState(interimState, args[i]);
      }

      const callDataArrayHex = callDataArray.map(c => '0x' + c.toString('hex'));
      const newStateHex = '0x' + interimState.toString('hex');

      // Build an Append Proof that enables appending new call data to the call data tree
      const { proof, newMerkleTree } = callDataTree.appendMulti(callDataArray, proofOptions);
      const { compactProof: appendProof } = proof;
      const proofHex = appendProof.map(p => '0x' + p.toString('hex'));

      const { receipt, logs } = await contractInstance.perform_many_optimistically_and_enter(
        callDataArrayHex,
        newStateHex,
        proofHex,
        { from: suspect }
      );

      // Since the transaction executed successfully, update the locally maintained variables
      const block = await web3.eth.getBlock(receipt.blockNumber);
      lastTime = block.timestamp;
      callDataTree = newMerkleTree;
      currentState = interimState;

      const accountState = await contractInstance.account_states(suspect);
      const expectedAccountState = hashPacked([callDataTree.root, currentState, to32ByteBuffer(lastTime)]);

      expect(logs[0].event).to.equal('New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(lastTime.toString());

      expect(accountState).to.equal('0x' + expectedAccountState.toString('hex'));

      expect(receipt.gasUsed).to.equal(261608);
    });
  });
});
