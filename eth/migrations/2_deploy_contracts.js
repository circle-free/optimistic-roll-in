const OptimisticRollIn = artifacts.require("Optimistic_Roll_In.sol");
const SomeLogicContractArtifact = artifacts.require('Some_Logic_Contract');

module.exports = function(deployer, network) {
  deployer.deploy(SomeLogicContractArtifact)
    .then(() => SomeLogicContractArtifact.deployed())
    .then(logicContact => {
      const lockTime = network === 'development' ? '600' : '60';   // 10 minutes or 1 minute
      const requiredBond = network === 'development' ? '1000000000000000000' : '10000000000000';   // 1 or 0.0001

      return deployer.deploy(OptimisticRollIn, logicContact.address, lockTime, requiredBond);
    })
    .then(() => OptimisticRollIn.deployed());
};
