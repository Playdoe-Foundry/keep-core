import {initContracts} from '../helpers/initContracts';
import {createSnapshot, restoreSnapshot} from '../helpers/snapshot';
import {bls} from '../helpers/data';

contract('KeepRandomBeaconService/PricingFees', function(accounts) {
    let serviceContract;
    let operatorContract;

    before(async () => {
        let contracts = await initContracts(
          artifacts.require('./KeepToken.sol'),
          artifacts.require('./TokenStaking.sol'),
          artifacts.require('./KeepRandomBeaconService.sol'),
          artifacts.require('./KeepRandomBeaconServiceImplV1.sol'),
          artifacts.require('./stubs/KeepRandomBeaconOperatorPricingStub.sol')
        );
    
        serviceContract = contracts.serviceContract;
        operatorContract = contracts.operatorContract;

        await operatorContract.registerNewGroup(bls.groupPubKey);
    });

    beforeEach(async () => {
        await createSnapshot()
    });
    
    afterEach(async () => {
      await restoreSnapshot()
    });

    it("should correctly evaluate entry verification fee", async () => {
        await operatorContract.setGasPriceCeiling(200);
        await operatorContract.setEntryVerificationGasEstimate(12);        

        let fees = await serviceContract.entryFeeBreakdown();
        let entryVerificationFee = fees.entryVerificationFee;

        let expectedEntryVerificationFee = 2400; // 200 * 12
        assert.equal(expectedEntryVerificationFee, entryVerificationFee);
    });

    it("should correctly evaluate DKG contribution fee", async () => {
        await operatorContract.setGasPriceCeiling(1234);
        await operatorContract.setDkgGasEstimate(13);
        await operatorContract.setGroupSelectionGasEstimate(2);

        let fees = await serviceContract.entryFeeBreakdown();
        let dkgContributionFee = fees.dkgContributionFee;

        let expectedDkgContributionFee = 185; // 1234 * (13+2) * 1% = 185.1
        assert.equal(expectedDkgContributionFee, dkgContributionFee);
    });

    it("should correctly evaluate entry fee estimate", async () => {
        await operatorContract.setGasPriceCeiling(200);
        await operatorContract.setEntryVerificationGasEstimate(12); 
        await operatorContract.setDkgGasEstimate(14); 
        await operatorContract.setGroupSize(13);
        await operatorContract.setGroupMemberBaseReward(3);
        await operatorContract.setGroupSelectionGasEstimate(2);

        let callbackGas = 7;

        let entryFeeEstimate = await serviceContract.entryFeeEstimate(
            callbackGas
        );

        // entry verification fee = 12 * 200 = 2400
        // dkg contribution fee = (14 + 2) * 200 * 1% = 32
        // group profit fee = 13 * 3 = 39
        // callback fee = (10961 + 7) * 200 = 2193600
        // entry fee = 2400 + 32 + 39 + 2193600 = 3761671
        let expectedEntryFeeEstimate = 2196071;
        assert.equal(expectedEntryFeeEstimate, entryFeeEstimate)
    });
});
