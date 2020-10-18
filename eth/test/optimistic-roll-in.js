const chai = require('chai');
const { expect } = chai;
const crypto = require('crypto');

const OptimisticRollInArtifact = artifacts.require("Optimistic_Roll_In");
const SomeLogicContractArtifact = artifacts.require("Some_Logic_Contract");

const OptimisticRollIn = require('../../js/src');
const { to32ByteBuffer, hashPacked, toHex } = require('../../js/src/utils');

const treeOptions = {
  elementPrefix: '00',
};

const getInitialState = () => to32ByteBuffer(0);

const somePureTransition = (currentState, arg) => {
  let newState = Buffer.isBuffer(currentState) ? currentState : Buffer.from(currentState.slice(2), 'hex');
  arg = Buffer.isBuffer(arg) ? arg : Buffer.from(arg.slice(2), 'hex');

  for (let i= 0; i < 1000; i++) {
    newState = hashPacked([newState, arg]);
  }

  return newState;
};

const somePureTransitionFraud = (fraudIndex) => {
  let callCount = 0;

  const fraudFunction = (currentState, argHex) => {
    if (callCount++ === fraudIndex) return to32ByteBuffer(1337);

    return somePureTransition(currentState, argHex);
  };

  return fraudFunction;
};

const logicFunctions = {
  'get_initial_state': getInitialState,
  'some_pure_transition': somePureTransition,
};


const generateRandomElement = () => {
  return crypto.randomBytes(32);
};

const generateElements = (elementCount, options = {}) => {
  const { seed, random = false } = options;
  const elements = [];
  let seedBuffer = seed ? Buffer.from(seed, 'hex') : null;
  let element = seedBuffer;

  for (let i = 0; i < elementCount; i++) {
    element = random ? generateRandomElement() : seed ? hashPacked([seedBuffer, element]) : to32ByteBuffer(i);
    seedBuffer = seed ? element : seedBuffer;
    elements.push(element);
  }

  return elements;
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

    let suspectOptimist = null;
    let accuserOptimist = null;
    let suspectLastTxId = null;

    let suspectBondAmount = null;
    let accuserBondAmount = null;

    let logicContractInstance = null;
    let logicAddress = null;
    let contractInstance = null;
    let fraudulentTransitionIndex = null;

    before(async () => {
      logicContractInstance = await SomeLogicContractArtifact.new();
      logicAddress = logicContractInstance.address;
      contractInstance = await OptimisticRollInArtifact.new(logicAddress, initialStateSelector);

      const oriOptions = { treeOptions, web3 };

      suspectOptimist = new OptimisticRollIn(contractInstance, logicContractInstance, logicFunctions, suspect, oriOptions);
      accuserOptimist = new OptimisticRollIn(contractInstance, logicContractInstance, logicFunctions, accuser, oriOptions);
    });

    it("[ 1] can bond a user (who will eventually be the guilty suspect).", async () => {
      suspectBondAmount = '1000000000000000000';
      const { receipt } = await suspectOptimist.bond(suspectBondAmount);
      const balance = await contractInstance.balances(suspect);

      expect(balance.toString()).to.equal(suspectBondAmount);
      expect(receipt.gasUsed).to.equal(42706);
    });

    it("[ 2] can initialize a user (suspect).", async () => {
      const { receipt, logs } = await suspectOptimist.initialize();
      const accountState = await contractInstance.account_states(suspect);

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(logs[0].event).to.equal('ORI_Initialized');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(toHex(suspectOptimist.currentState));

      expect(receipt.gasUsed).to.equal(46487);
    });

    it("[ 3] allows a user (suspect) to perform a normal state transition (and remain outside of optimism).", async () => {
      const someArg = generateElements(1, { seed: '11' })[0];
      const args = [toHex(someArg)];

      const { receipt } = await suspectOptimist.perform('some_pure_transition', args);
      const accountState = await contractInstance.account_states(suspect);

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));
      expect(receipt.gasUsed).to.equal(286340);
    });

    it("[ 4] allows a user (suspect) to perform a valid optimistic state transition (and enter optimism).", async () => {
      const someArg = generateElements(1, { seed: '22' })[0];
      const args = [toHex(someArg)];

      const { receipt, logs } = await suspectOptimist.performIntoOptimism('some_pure_transition', args);
      const accountState = await contractInstance.account_states(suspect);
      suspectLastTxId = receipt.transactionHash;

      expect(logs[0].event).to.equal('ORI_New_Optimistic_State');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(33971);
    });

    it("[ 5] allows a user (accuser) to immediately verify a valid optimistic state transition.", async () => {
      const { valid, user } = await accuserOptimist.verifyTransaction(suspectLastTxId, web3);

      expect(valid).to.be.true;
      expect(user).to.equal(suspect.toLowerCase());
    });

    it("[ 6] allows a user (suspect) to perform a valid optimistic state transition.", async () => {
      const someArg = generateElements(1, { seed: '33' })[0];
      const args = [toHex(someArg)];
      
      const { receipt, logs } = await suspectOptimist.performOptimistically('some_pure_transition', args);
      const accountState = await contractInstance.account_states(suspect);
      suspectLastTxId = receipt.transactionHash;

      expect(logs[0].event).to.equal('ORI_New_Optimistic_State');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(35790);
    });

    it("[ 7] allows a user (accuser) to immediately verify a valid optimistic state transition.", async () => {
      const { valid, user } = await accuserOptimist.verifyTransaction(suspectLastTxId, web3);

      expect(valid).to.be.true;
      expect(user).to.equal(suspect.toLowerCase());
    });

    it("[ 8] allows a user (suspect) to perform valid optimistic state transitions in batch.", async () => {
      const calls = 100;
      const someArgs = generateElements(calls, { seed: '44' });
      const args = toHex(someArgs).map(a => [a]);
      const functions = args.map(() => 'some_pure_transition');
      
      const { receipt, logs } = await suspectOptimist.performManyOptimistically(functions, args);
      const accountState = await contractInstance.account_states(suspect);
      suspectLastTxId = receipt.transactionHash;

      expect(logs[0].event).to.equal('ORI_New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(286162);
    });

    it("[ 9] allows a user (accuser) to immediately verify valid batched optimistic state transitions.", async () => {
      const { valid, user } = await accuserOptimist.verifyTransaction(suspectLastTxId, web3);

      expect(valid).to.be.true;
      expect(user).to.equal(suspect.toLowerCase());
    });

    it("[10] allows a user (suspect) to perform fraudulent optimistic state transitions in batch.", async () => {
      const fraudulentIndex = 20;
      fraudulentTransitionIndex = suspectOptimist.transitionCount + fraudulentIndex;
      
      // Hijack the internal function
      logicFunctions["some_pure_transition"] = somePureTransitionFraud(fraudulentIndex);

      const calls = 100;
      const someArgs = generateElements(calls, { seed: '55' });
      const args = toHex(someArgs).map(a => [a]);
      const functions = args.map(() => 'some_pure_transition');
      
      const { receipt, logs } = await suspectOptimist.performManyOptimistically(functions, args);
      suspectLastTxId = receipt.transactionHash;

      // Reset the internal function
      logicFunctions["some_pure_transition"] = somePureTransition;

      const accountState = await contractInstance.account_states(suspect);

      expect(logs[0].event).to.equal('ORI_New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(289241);
    });

    it("[11] allows a user (accuser) to immediately detect a transaction containing a fraudulent state transition.", async () => {
      const { valid, user } = await accuserOptimist.verifyTransaction(suspectLastTxId, web3);

      expect(valid).to.be.false;
      expect(user).to.equal(suspect.toLowerCase());

      const fraudster = accuserOptimist.getFraudster(suspect);
      const accountState = await contractInstance.account_states(suspect);

      expect(fraudster.fraudIndex).to.equal(fraudulentTransitionIndex);
      expect(accountState).to.equal(toHex(fraudster.accountState));
    });

    it("[12] allows a user (suspect) to perform a valid optimistic state transition on top of an invalid state.", async () => {
      const someArg = generateElements(1, { seed: '66' })[0];
      const args = [toHex(someArg)];
      
      const { receipt, logs } = await suspectOptimist.performOptimistically('some_pure_transition', args);
      const accountState = await contractInstance.account_states(suspect);
      suspectLastTxId = receipt.transactionHash;

      expect(logs[0].event).to.equal('ORI_New_Optimistic_State');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(38283);
    });

    it("[13] allows a user (accuser) to update their local partial tree with the suspect's pre-lockout valid transition.", async () => {
      const fraudster = accuserOptimist.getFraudster(suspect);
      
      await fraudster.update(suspectLastTxId);
      const accountState = await contractInstance.account_states(suspect);

      // We expect this partial tree roots, when combined, to have the same root as the suspects combined trees on-chain
      expect(accountState).to.equal(toHex(fraudster.accountState));
    });

    it("[14] allows a user (suspect) to perform valid optimistic state transitions in batch on top of an invalid state.", async () => {
      const calls = 20;
      const someArgs = generateElements(calls, { seed: '77' });
      const args = toHex(someArgs).map(a => [a]);
      const functions = args.map(() => 'some_pure_transition');
      
      const { receipt, logs } = await suspectOptimist.performManyOptimistically(functions, args);
      const accountState = await contractInstance.account_states(suspect);
      suspectLastTxId = receipt.transactionHash;

      expect(logs[0].event).to.equal('ORI_New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(90447);
    });

    it("[15] allows a user (accuser) to lock a suspect's account for a time frame.", async () => {
      // An accuser, who previously detected the fraudulent transition will, will lock out the suspect (and bond themselves at the same time)
      accuserBondAmount = '1000000000000000000';
      const fraudster = accuserOptimist.getFraudster(suspect);
      const { receipt, logs } = await fraudster.lock({ bond: accuserBondAmount });

      const block = await web3.eth.getBlock(receipt.blockNumber);
      const balance = await contractInstance.balances(accuser);
      const suspectLocker = await contractInstance.lockers(suspect);
      const suspectLockedTime = await contractInstance.locked_times(suspect);
      const accuserLocker = await contractInstance.lockers(accuser);
      const accuserLockedTime = await contractInstance.locked_times(accuser);

      expect(logs[0].event).to.equal('ORI_Locked');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1]).to.equal(accuser);

      expect(balance.toString()).to.equal(accuserBondAmount);

      expect(suspectLocker).to.equal(accuser);
      expect(suspectLockedTime.toString()).to.equal(block.timestamp.toString());
      expect(accuserLocker).to.equal(accuser);
      expect(accuserLockedTime.toString()).to.equal(block.timestamp.toString());

      expect(receipt.gasUsed).to.equal(128020);
    });

    it("[16] allows a user (accuser) to update their local partial tree with the suspect's pre-lockout valid transition.", async () => {
      const fraudster = accuserOptimist.getFraudster(suspect);
      
      await fraudster.update(suspectLastTxId);
      const accountState = await contractInstance.account_states(suspect);

      // We expect this partial tree roots, when combined, to have the same root as the suspects combined trees on-chain
      expect(accountState).to.equal(toHex(fraudster.accountState));
    });

    it("[17] allows a user (accuser) to prove a suspect's fraud (from a partial tree).", async () => {
      const fraudster = accuserOptimist.getFraudster(suspect);

      // Prove the fraud
      const { receipt, logs } = await fraudster.proveFraud();

      const suspectBalance = await contractInstance.balances(suspect);
      const suspectLocker = await contractInstance.lockers(suspect);
      const suspectLockedTime = await contractInstance.locked_times(suspect);
      const suspectRollbackSize = await contractInstance.rollback_sizes(suspect);

      const accuserBalance = await contractInstance.balances(accuser);
      const accuserLocker = await contractInstance.lockers(accuser);
      const accuserLockedTime = await contractInstance.locked_times(accuser);

      const expectedAccuserBalance = web3.utils.toBN(suspectBondAmount).add(web3.utils.toBN(accuserBondAmount)).toString();

      expect(logs[0].event).to.equal('ORI_Fraud_Proven');
      expect(logs[0].args[0]).to.equal(accuser);
      expect(logs[0].args[1]).to.equal(suspect);
      expect(logs[0].args[2].toString()).to.equal(fraudulentTransitionIndex.toString());
      expect(logs[0].args[3].toString()).to.equal(suspectBondAmount);
      suspectBondAmount = '0';

      expect(suspectBalance.toString()).to.equal('0');
      expect(suspectLocker).to.equal(suspect);
      expect(suspectLockedTime.toString()).to.equal('0');
      expect(suspectRollbackSize.toString()).to.equal(fraudulentTransitionIndex.toString());

      expect(accuserBalance.toString()).to.equal(expectedAccuserBalance);
      expect(accuserLocker).to.equal(zeroAddress);
      expect(accuserLockedTime.toString()).to.equal('0');

      expect(receipt.gasUsed).to.equal(298463);
    });

    it("[18] allows a user (accuser) to withdraw their balance (including the reward).", async () => {
      const startingEth = BigInt(await web3.eth.getBalance(accuser));
      const { receipt } = await accuserOptimist.withdraw(accuser);
      const endingEth = BigInt(await web3.eth.getBalance(accuser));
      const balanceUser0 = await contractInstance.balances(suspect);
      const balanceUser1 = await contractInstance.balances(accuser);

      accuserBondAmount = '0';

      expect((endingEth - startingEth).toString()).to.equal('1999578880000000000');
      expect(balanceUser0.toString()).to.equal('0');
      expect(balanceUser1.toString()).to.equal('0');
      expect(receipt.gasUsed).to.equal(21056);
    });
  
    it("[19] allows a user (suspect) to rollback their call data tree.", async () => {
      suspectBondAmount = '1000000000000000000';
      const { receipt, logs } = await suspectOptimist.rollback(fraudulentTransitionIndex, { bondAmount: suspectBondAmount });

      const accountState = await contractInstance.account_states(suspect);

      const suspectBalance = await contractInstance.balances(suspect);
      const suspectLocker = await contractInstance.lockers(suspect);
      const suspectRollbackSize = await contractInstance.rollback_sizes(suspect);

      expect(logs[0].event).to.equal('ORI_Rolled_Back');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(fraudulentTransitionIndex.toString());
      expect(logs[0].args[2].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(suspectBalance.toString()).to.equal(suspectBondAmount);
      expect(suspectLocker).to.equal(zeroAddress);
      expect(suspectRollbackSize.toString()).to.equal('0');

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(296929);
    });

    it("[20] allows a user (suspect) to re-perform valid optimistic state transitions in batch.", async () => {
      const calls = 100;
      const someArgs = generateElements(calls, { seed: '55' });
      const args = toHex(someArgs).map(a => [a]);
      const functions = args.map(() => 'some_pure_transition');
      
      const { receipt, logs } = await suspectOptimist.performManyOptimistically(functions, args);
      const accountState = await contractInstance.account_states(suspect);
      suspectLastTxId = receipt.transactionHash;

      expect(logs[0].event).to.equal('ORI_New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(290505);
    });

    it("[21] allows a user (suspect) to perform a normal state transition (and exit optimism).", async () => {
      // Need to increase time by at least 600 seconds for this to be allowed
      await advanceTime(suspectOptimist.lastTime + 700);
      
      const someArg = generateElements(1, { seed: '88' })[0];
      const args = [toHex(someArg)];
      
      const { receipt, logs } = await suspectOptimist.performOutOfOptimism('some_pure_transition', args);
      const accountState = await contractInstance.account_states(suspect);

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(logs[0].event).to.equal('ORI_Exited_Optimism');
      expect(logs[0].args[0]).to.equal(suspect);

      expect(receipt.gasUsed).to.equal(289522);
    });

    it("[22] allows a user (suspect) to perform valid optimistic state transitions in batch (and reenter optimism).", async () => {
      const calls = 50;
      const someArgs = generateElements(calls, { seed: '99' });
      const args = toHex(someArgs).map(a => [a]);
      const functions = args.map(() => 'some_pure_transition');
      
      const { receipt, logs } = await suspectOptimist.performManyIntoOptimism(functions, args);
      const accountState = await contractInstance.account_states(suspect);
      suspectLastTxId = receipt.transactionHash;

      expect(logs[0].event).to.equal('ORI_New_Optimistic_States');
      expect(logs[0].args[0]).to.equal(suspect);
      expect(logs[0].args[1].toString()).to.equal(suspectOptimist.lastTime.toString());

      expect(accountState).to.equal(toHex(suspectOptimist.accountState));

      expect(receipt.gasUsed).to.equal(147939);
    });
  });
});
