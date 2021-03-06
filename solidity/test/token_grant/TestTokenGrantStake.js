import increaseTime, { duration, increaseTimeTo} from '../helpers/increaseTime';
import latestTime from '../helpers/latestTime';
import expectThrowWithMessage from '../helpers/expectThrowWithMessage'
import grantTokens from '../helpers/grantTokens';
import { createSnapshot, restoreSnapshot } from '../helpers/snapshot'
import delegateStakeFromGrant from '../helpers/delegateStakeFromGrant'

const BN = web3.utils.BN
const chai = require('chai')
chai.use(require('bn-chai')(BN))
const expect = chai.expect

// Depending on test network increaseTimeTo can be inconsistent and add
// extra time. As a workaround we subtract timeRoundMargin in all cases
// that test times before initialization/undelegation periods end.
const timeRoundMargin = duration.minutes(1)

const KeepToken = artifacts.require('./KeepToken.sol');
const TokenStaking = artifacts.require('./TokenStaking.sol');
const TokenGrant = artifacts.require('./TokenGrant.sol');
const Registry = artifacts.require("./Registry.sol");
const PermissiveStakingPolicy = artifacts.require('./PermissiveStakingPolicy.sol');
const GuaranteedMinimumStakingPolicy = artifacts.require('./GuaranteedMinimumStakingPolicy.sol');
const EvilStakingPolicy = artifacts.require('./EvilStakingPolicy.sol');

contract('TokenGrant/Stake', function(accounts) {

  let tokenContract, registryContract, grantContract, stakingContract,
    permissivePolicy, minimumPolicy, evilPolicy,
    minimumStake, grantAmount;

  const tokenOwner = accounts[0],
    grantee = accounts[1],
    operatorOne = accounts[2],
    operatorTwo = accounts[3],
    magpie = accounts[4],
    authorizer = accounts[5],
    revocableGrantee = accounts[6],
    evilGrantee = accounts[7];

  let grantId;
  let revocableGrantId;
  let evilGrantId;
  let grantStart;

  const grantUnlockingDuration = duration.days(60);
  const grantCliff = duration.days(10);

  const initializationPeriod = duration.minutes(10);
  const undelegationPeriod = duration.minutes(30);

  before(async () => {
    tokenContract = await KeepToken.new();
    registryContract = await Registry.new();
    stakingContract = await TokenStaking.new(
      tokenContract.address,
      registryContract.address,
      initializationPeriod,
      undelegationPeriod
    );

    grantContract = await TokenGrant.new(tokenContract.address);

    await grantContract.authorizeStakingContract(stakingContract.address);


    grantStart = await latestTime();
    minimumStake = await stakingContract.minimumStake()

    permissivePolicy = await PermissiveStakingPolicy.new()
    minimumPolicy = await GuaranteedMinimumStakingPolicy.new(stakingContract.address);
    evilPolicy = await EvilStakingPolicy.new()
    grantAmount = minimumStake.muln(10),

    // Grant tokens
    grantId = await grantTokens(
      grantContract,
      tokenContract,
      grantAmount,
      tokenOwner,
      grantee,
      grantUnlockingDuration,
      grantStart,
      grantCliff,
      false,
      permissivePolicy.address,
    );

    revocableGrantId = await grantTokens(
      grantContract,
      tokenContract,
      grantAmount,
      tokenOwner,
      revocableGrantee,
      grantUnlockingDuration,
      grantStart,
      grantCliff,
      true,
      minimumPolicy.address,
    );

    evilGrantId = await grantTokens(
      grantContract,
      tokenContract,
      grantAmount,
      tokenOwner,
      evilGrantee,
      grantUnlockingDuration,
      grantStart,
      grantCliff,
      false,
      evilPolicy.address,
    );
  });

  beforeEach(async () => {
    await createSnapshot()
  })

  afterEach(async () => {
    await restoreSnapshot()
  })

  async function delegate(grantee, operator, amount) {
    return await delegateStakeFromGrant(
      grantContract,
      stakingContract.address,
      grantee,
      operator,
      magpie,
      authorizer,
      amount,
      grantId
    )
  }

  async function delegateRevocable(grantee, operator, amount) {
    return await delegateStakeFromGrant(
      grantContract,
      stakingContract.address,
      grantee,
      operator,
      magpie,
      authorizer,
      amount,
      revocableGrantId
    )
  }

  async function delegateEvil(grantee, operator, amount) {
    return await delegateStakeFromGrant(
      grantContract,
      stakingContract.address,
      grantee,
      operator,
      magpie,
      authorizer,
      amount,
      evilGrantId
    )
  }

  it("should update balances when delegating", async () => {
    let amountToDelegate = minimumStake.muln(5);
    let remaining = grantAmount.sub(amountToDelegate)

    await delegate(grantee, operatorOne, amountToDelegate);

    let availableForStaking = await grantContract.availableToStake.call(grantId)
    let operatorBalance = await stakingContract.balanceOf.call(operatorOne);

    expect(availableForStaking).to.eq.BN(
      remaining,
      "All granted tokens delegated, should be nothing more available"
    )
    expect(operatorBalance).to.eq.BN(
      amountToDelegate,
      "Staking amount should be added to the operator balance"
    );
  })

  it("should allow to delegate, undelegate, and recover grant", async () => {
    let tx = await delegate(grantee, operatorOne, grantAmount)
    let createdAt = (await web3.eth.getBlock(tx.receipt.blockNumber)).timestamp

    await increaseTimeTo(createdAt + initializationPeriod + 1)
    tx = await grantContract.undelegate(operatorOne, {from: grantee})
    let undelegatedAt = (await web3.eth.getBlock(tx.receipt.blockNumber)).timestamp
    await increaseTimeTo(undelegatedAt + undelegationPeriod + 1)
    await grantContract.recoverStake(operatorOne);

    let availableForStaking = await grantContract.availableToStake.call(grantId)
    let operatorBalance = await stakingContract.balanceOf.call(operatorOne);

    expect(availableForStaking).to.eq.BN(
      grantAmount,
      "All granted tokens should be again available for staking"
    )
    expect(operatorBalance).to.eq.BN(
      0,
      "Staking amount should be removed from operator balance"
    );
  })

  it("should allow to cancel delegation right away", async () => {
    await delegate(grantee, operatorOne, grantAmount);

    await grantContract.cancelStake(operatorOne, {from: grantee});

    let availableForStaking = await grantContract.availableToStake.call(grantId)
    let operatorBalance = await stakingContract.balanceOf.call(operatorOne);

    expect(availableForStaking).to.eq.BN(
      grantAmount,
      "All granted tokens should be again available for staking"
    )
    expect(operatorBalance).to.eq.BN(
      0,
      "Staking amount should be removed from operator balance"
    );
  })

  it("should allow to cancel delegation just before initialization period is over", async () => {
    let tx = await delegate(grantee, operatorOne, grantAmount)
    let createdAt = (await web3.eth.getBlock(tx.receipt.blockNumber)).timestamp

    await increaseTimeTo(createdAt + initializationPeriod - timeRoundMargin)

    await grantContract.cancelStake(operatorOne, {from: grantee});

    let availableForStaking = await grantContract.availableToStake.call(grantId)
    let operatorBalance = await stakingContract.balanceOf.call(operatorOne);

    expect(availableForStaking).to.eq.BN(
      grantAmount,
      "All granted tokens should be again available for staking"
    )
    expect(operatorBalance).to.eq.BN(
      0,
      "Staking amount should be removed from operator balance"
    );
  })

  it("should not allow to cancel delegation after initialization period is over", async () => {
    let tx = await delegate(grantee, operatorOne, grantAmount)
    let createdAt = (await web3.eth.getBlock(tx.receipt.blockNumber)).timestamp

    await increaseTimeTo(createdAt + initializationPeriod + 1)

    await expectThrowWithMessage(
      grantContract.cancelStake(operatorOne, {from: grantee}),
      "Initialization period is over"
    );
  })

  it("should not allow to recover stake before undelegation period is over", async () => {
    let tx = await delegate(grantee, operatorOne, grantAmount)
    let createdAt = (await web3.eth.getBlock(tx.receipt.blockNumber)).timestamp

    await increaseTimeTo(createdAt + initializationPeriod + 1)
    tx = await grantContract.undelegate(operatorOne, {from: grantee})
    let undelegatedAt = (await web3.eth.getBlock(tx.receipt.blockNumber)).timestamp
    await increaseTimeTo(undelegatedAt + undelegationPeriod - timeRoundMargin);

    await expectThrowWithMessage(
      stakingContract.recoverStake(operatorOne),
      "Can not recover stake before undelegation period is over"
    )
  })

  it("should not allow to delegate to the same operator twice", async () => {
    let amountToDelegate = minimumStake.muln(5);
    await delegate(grantee, operatorOne, amountToDelegate);

    await expectThrowWithMessage(
      delegate(grantee, operatorOne, amountToDelegate, grantId),
      "Operator address is already in use"
    )
  })

  it("should not allow to delegate to the same operator even after recovering stake", async () => {
    let tx = await delegate(grantee, operatorOne, grantAmount)
    let createdAt = (await web3.eth.getBlock(tx.receipt.blockNumber)).timestamp
    await increaseTimeTo(createdAt + initializationPeriod + 1)
    tx = await grantContract.undelegate(operatorOne, {from: grantee})
    let undelegatedAt = (await web3.eth.getBlock(tx.receipt.blockNumber)).timestamp
    await increaseTimeTo(undelegatedAt + undelegationPeriod + 1)
    await grantContract.recoverStake(operatorOne, {from: grantee});

    await expectThrowWithMessage(
      delegate(grantee, operatorOne, grantAmount),
      "Operator address is already in use."
    )
  })

  it("should allow to delegate to two different operators", async () => {
    let amountToDelegate = minimumStake.muln(5);

    await delegate(grantee, operatorOne, amountToDelegate);
    await delegate(grantee, operatorTwo, amountToDelegate);

    let availableForStaking = await grantContract.availableToStake.call(grantId)
    let operatorOneBalance = await stakingContract.balanceOf.call(operatorOne);
    let operatorTwoBalance = await stakingContract.balanceOf.call(operatorTwo);

    expect(availableForStaking).to.eq.BN(
      grantAmount.sub(amountToDelegate).sub(amountToDelegate),
      "All granted tokens delegated, should be nothing more available"
    )
    expect(operatorOneBalance).to.eq.BN(
      amountToDelegate,
      "Staking amount should be added to the operator balance"
    );
    expect(operatorTwoBalance).to.eq.BN(
      amountToDelegate,
      "Staking amount should be added to the operator balance"
    );
  })

  it("should not allow to delegate to not authorized staking contract", async () => {
    const delegation = Buffer.concat([
      Buffer.from(magpie.substr(2), 'hex'),
      Buffer.from(operatorOne.substr(2), 'hex'),
      Buffer.from(authorizer.substr(2), 'hex')
    ]);

    const notAuthorizedContract = "0x9E8E3487dCCd6a50045792fAfe8Ac71600B649a9"

    await expectThrowWithMessage(
      grantContract.stake(
        grantId,
        notAuthorizedContract,
        grantAmount,
        delegation,
        {from: grantee}
      ),
      "Provided staking contract is not authorized"
    )
  })

  it("should not allow anyone but grantee to delegate", async () => {
    await expectThrowWithMessage(
      delegate(operatorOne, operatorOne, grantAmount),
      "Only grantee of the grant can stake it."
    );
  })

  it("should let operator cancel delegation", async () => {
    await delegate(grantee, operatorOne, grantAmount, grantId);

    await grantContract.cancelStake(operatorOne, {from: operatorOne})
    // ok, no exception
  })

  it("should not allow third party to cancel delegation", async () => {
    await delegate(grantee, operatorOne, grantAmount);

    await expectThrowWithMessage(
      grantContract.cancelStake(operatorOne, {from: operatorTwo}),
      "Only operator or grantee can cancel the delegation."
    );
  })

  it("should let operator undelegate", async () => {
    let tx = await delegate(grantee, operatorOne, grantAmount)
    let createdAt = (await web3.eth.getBlock(tx.receipt.blockNumber)).timestamp

    await increaseTimeTo(createdAt + initializationPeriod + 1)
    await grantContract.undelegate(operatorOne, {from: operatorOne})
    // ok, no exceptions
  })

  it("should not allow third party to undelegate", async () => {
    let tx = await delegate(grantee, operatorOne, grantAmount)
    let createdAt = (await web3.eth.getBlock(tx.receipt.blockNumber)).timestamp

    await increaseTimeTo(createdAt + initializationPeriod + 1)
    await expectThrowWithMessage(
      grantContract.undelegate(operatorOne, {from: operatorTwo}),
      "Only operator or grantee can undelegate"
    )
  })

  it("should recover tokens recovered outside the grant contract", async () => {
    let tx = await delegate(grantee, operatorOne, grantAmount)
    let createdAt = (await web3.eth.getBlock(tx.receipt.blockNumber)).timestamp

    await increaseTimeTo(createdAt + initializationPeriod + 1)
    tx = await grantContract.undelegate(operatorOne, {from: grantee})
    let undelegatedAt = (await web3.eth.getBlock(tx.receipt.blockNumber)).timestamp
    await increaseTimeTo(undelegatedAt + undelegationPeriod + 1)
    await stakingContract.recoverStake(operatorOne);
    let availablePre = await grantContract.availableToStake(grantId);

    expect(availablePre).to.eq.BN(
      0,
      "Staked tokens should be displaced"
    );

    await grantContract.recoverStake(operatorOne);
    let availablePost = await grantContract.availableToStake(grantId);

    expect(availablePost).to.eq.BN(
      grantAmount,
      "Staked tokens should be recovered safely"
    );
  })

  it("should allow delegation of revocable grants", async () => {
    await delegateRevocable(revocableGrantee, operatorTwo, minimumStake);
    // ok, no exceptions
  })

  it("should not allow delegation of more than permitted", async () => {
    await expectThrowWithMessage(
      delegateRevocable(revocableGrantee, operatorTwo, minimumStake.addn(1)),
      "Must have available granted amount to stake."
    );
  })

  it("should allow delegation of evil grants", async () => {
    await delegateEvil(evilGrantee, operatorTwo, grantAmount);
    // ok, no exceptions
  })

  it("should not allow delegation of more than in the grant", async () => {
    await expectThrowWithMessage(
      delegateEvil(evilGrantee, operatorTwo, grantAmount.addn(1)),
      "Must have available granted amount to stake."
    );
  })
});
