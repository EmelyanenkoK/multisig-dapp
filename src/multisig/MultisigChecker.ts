import {
    AddressInfo,
    addressToString,
    assert,
    equalsAddressLists,
    formatAddressAndUrl,
    getAddressFormat
} from "../utils/utils";
import {Address, Cell, Dictionary} from "@ton/core";
import {endParse, Multisig, parseMultisigData} from "./Multisig";
import {MyNetworkProvider, sendToIndex, sendToTonApi} from "../utils/MyNetworkProvider";
import {Op} from "./Constants";
import {Order} from "./Order";
import {checkMultisigOrder, MultisigOrderInfo} from "./MultisigOrderChecker";

const parseNewOrderInitStateBody = (cell: Cell) => {
    const slice = cell.beginParse();
    const multisigAddress = slice.loadAddress();
    const orderId = slice.loadUintBig(256);
    endParse(slice);
    return {
        multisigAddress,
        orderId
    }
}

const parseNewOrderInitState = (cell: Cell) => {
    const slice = cell.beginParse();
    if (slice.loadUint(2) !== 0) throw new Error('invalid init state prefix');
    const code = slice.loadMaybeRef()!;
    const body = slice.loadMaybeRef()!;
    if (slice.loadBoolean()) throw new Error('invalid init state empty libraries');
    endParse(slice);
    return {
        code,
        body: parseNewOrderInitStateBody(body)
    }
}

/**
 * @param outMsg - out msg from toncenter v3
 */
const parseNewOrderOutMsg = (outMsg: any) => {
    const orderAddress = Address.parse(outMsg.destination);
    const initState = Cell.fromBase64(outMsg.init_state.body);
    const parsed = parseNewOrderInitState(initState)

    const body = Cell.fromBase64(outMsg.message_content.body).beginParse();
    assert(body.loadUint(32) === Op.order.init, "invalid op");
    const queryId = body.loadUint(64);
    const threshold = body.loadUint(8);
    const signers = body.loadRef().beginParse().loadDictDirect(Dictionary.Keys.Uint(8), Dictionary.Values.Address());
    const expiredAt = body.loadUint(48);
    const order = body.loadRef().beginParse().loadDictDirect(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());
    const isSigner = body.loadUint(1);
    let signerIndex = undefined;
    if (isSigner) {
        signerIndex = body.loadUint(8);
    }

    console.log('OUT', {
        queryId,
        threshold,
        signers,
        expiredAt,
        order,
        isSigner,
        signerIndex,
    })

    endParse(body);

    return {
        orderAddress,
        orderId: parsed.body.orderId
    }
}

export interface LastOrder {
    utime: number,
    transactionHash: string;
    type: 'new' | 'execute' | 'pending' | 'executed';
    errorMessage?: string;
    order?: {
        address: AddressInfo;
        id: bigint;
    }
    orderInfo?: MultisigOrderInfo;
}

export interface MultisigInfo {
    address: AddressInfo;
    multisigContract: Multisig;
    provider: MyNetworkProvider;
    signers: AddressInfo[];
    proposers: AddressInfo[];
    threshold: number;
    allowArbitraryOrderSeqno: boolean;
    nextOderSeqno: bigint;
    tonBalance: bigint;
    lastOrders: LastOrder[];
    stateInitMatches: boolean;
}

export const checkMultisig = async (
    multisigAddress: AddressInfo,
    multisigCode: Cell,
    multisigOrderCode: Cell,
    isTestnet: boolean,
    lastOrdersMode: 'none' | 'history' | 'aggregate',
    needAdditionalChecks: boolean,
    isExpertMode:boolean
): Promise<MultisigInfo> => {

    // Account State and Data

    const result = await sendToIndex('account', {address: addressToString(multisigAddress)}, isTestnet);
    assert(result.status === 'active', "Contract not active. If you have just created a multisig it should appear within ~30 seconds.");

    assert(Cell.fromBase64(result.code).equals(multisigCode), 'The contract code DOES NOT match the multisig code from this repository');

    const tonBalance = result.balance;

    const data = Cell.fromBase64(result.data);
    const parsedData = parseMultisigData(data);

    if (parsedData.allowArbitraryOrderSeqno) {
        assert(parsedData.nextOderSeqno === BigInt(0), 'invalid nextOrderSeqno for allowArbitraryOrderSeqno');
    }

    const signers = parsedData.signers;
    const proposers = parsedData.proposers;

    assert(signers.length === parsedData.signersCount, 'invalid signersCount');
    assert(parsedData.threshold > 0, 'threshold <= 0');
    assert(parsedData.threshold <= parsedData.signersCount, 'invalid threshold');

    const signersFormatted = [];
    for (const signer of signers) {
        signersFormatted.push(await getAddressFormat(signer, isTestnet));
    }
    const proposersFormatted = [];
    for (const proposer of proposers) {
        proposersFormatted.push(await getAddressFormat(proposer, isTestnet));
    }

    // Get-methods

    const multisigContract = Multisig.createFromAddress(multisigAddress.address);

    const provider = new MyNetworkProvider(multisigAddress.address, isTestnet);

    if (needAdditionalChecks) {
        const getData = await multisigContract.getMultisigData(provider);

        if (parsedData.allowArbitraryOrderSeqno) {
            assert(getData.nextOrderSeqno === BigInt(-1), "nextOderSeqno doesn't match");
        } else {
            assert(getData.nextOrderSeqno === parsedData.nextOderSeqno, "nextOderSeqno doesn't match");
        }
        assert(getData.threshold === BigInt(parsedData.threshold), "threshold doesn't match");
        assert(equalsAddressLists(getData.signers, parsedData.signers), 'invalid signers');
        assert(equalsAddressLists(getData.proposers, parsedData.proposers), 'invalid proposers');
    }

    // State Init

    const multisigAddress2 = Multisig.createFromConfig({
        threshold: parsedData.threshold,
        signers: parsedData.signers,
        proposers: parsedData.proposers,
        allowArbitrarySeqno: parsedData.allowArbitraryOrderSeqno
    }, multisigCode)

    const stateInitMatches = multisigAddress2.address.equals(multisigAddress.address);


    const multisigInfo: MultisigInfo = {
        address: multisigAddress,
        multisigContract,
        provider,
        signers: signersFormatted,
        proposers: proposersFormatted,
        threshold: parsedData.threshold,
        allowArbitraryOrderSeqno: parsedData.allowArbitraryOrderSeqno,
        nextOderSeqno: parsedData.nextOderSeqno,
        tonBalance,
        lastOrders: [],
        stateInitMatches
    }

    // Last Orders

    let lastOrders: LastOrder[] = [];

    if (lastOrdersMode !== 'none') {

        const result = await sendToIndex('transactions', {account: addressToString(multisigAddress), limit: 256}, isTestnet);

        for (const tx of result.transactions) {
            if (!tx.in_msg.message_content) continue;
            if (!tx.in_msg.message_content.body) continue;

            const inBody = Cell.fromBase64(tx.in_msg.message_content.body);
            const inBodySlice = inBody.beginParse();
            if (inBodySlice.remainingBits < 32) {
                continue;
            }
            const op = inBodySlice.loadUint(32);

            if (op === 0x75097f5d) { // execute
                try {
                    const queryId = inBodySlice.loadUintBig(64);
                    const orderId = inBodySlice.loadUintBig(256);
                    const orderAddress = Address.parse(tx.in_msg.source);

                    const multisigOrderToCheck = Order.createFromConfig({
                        multisig: multisigAddress.address,
                        orderSeqno: orderId
                    }, multisigOrderCode);


                    if (!orderAddress.equals(multisigOrderToCheck.address)) {
                        throw new Error('fake order');
                    }

                    lastOrders.push({
                        utime: tx.now,
                        transactionHash: tx.hash,
                        type: 'execute',
                        order: {
                            address: {
                                address: orderAddress,
                                isBounceable: true,
                                isTestOnly: isTestnet
                            },
                            id: orderId
                        }
                    })

                } catch (e: any) {
                    lastOrders.push({
                        utime: tx.now,
                        transactionHash: tx.hash,
                        type: 'execute',
                        errorMessage: e.message
                    })
                }

            } else if (op === 0xf718510f) { // new_order
                try {
                    if (tx.out_msgs.length !== 1) throw new Error('invalid out messages');
                    const outMsg = tx.out_msgs[0];
                    const {orderAddress, orderId} = parseNewOrderOutMsg(outMsg);

                    const multisigOrderToCheck = Order.createFromConfig({
                        multisig: multisigAddress.address,
                        orderSeqno: orderId
                    }, multisigOrderCode);


                    if (!orderAddress.equals(multisigOrderToCheck.address)) {
                        throw new Error('fake order');
                    }

                    const queryId = inBodySlice.loadUint(64);
                    const _orderId = inBodySlice.loadUint(256);
                    const isSigner = inBodySlice.loadUint(1);
                    const index = inBodySlice.loadUint(8);
                    const expiredAt = inBodySlice.loadUint(48);
                    const order = inBodySlice.loadRef().beginParse().loadDictDirect(Dictionary.Keys.Uint(8), Dictionary.Values.Cell());

                    endParse(inBodySlice);

                    console.log('IN', {
                        queryId,
                        orderId,
                        orderAddress: orderAddress.toString(),
                        isSigner,
                        index,
                        expiredAt,
                        order
                    })

                    lastOrders.push({
                        utime: tx.now,
                        transactionHash: tx.hash,
                        type: 'new',
                        order: {
                            address: {
                                address: orderAddress,
                                isBounceable: true,
                                isTestOnly: isTestnet
                            },
                            id: orderId
                        }
                    })

                } catch (e: any) {
                    console.log(e);
                    lastOrders.push({
                        utime: tx.now,
                        transactionHash: tx.hash,
                        type: 'new',
                        errorMessage: 'Invalid new order: ' + e.message
                    })
                }
            }
        }

        if (lastOrdersMode === 'aggregate') {
            const lastOrdersMap: {[key: string]: LastOrder} = {};
            for (let lastOrder of lastOrders) {
                if (lastOrder.errorMessage) continue;

                const orderId = lastOrder.order.id.toString();

                if (!lastOrdersMap[orderId]) {
                    lastOrdersMap[orderId] = {
                        utime: lastOrder.utime,
                        transactionHash: lastOrder.transactionHash,
                        type: lastOrder.type === 'new' ? 'pending' : 'executed',
                        order: lastOrder.order
                    }
                } else {
                    if (lastOrdersMap[orderId].type !== 'executed' && lastOrder.type === 'execute') {
                        lastOrdersMap[orderId].utime = lastOrder.utime;
                        lastOrdersMap[orderId].type = 'executed';
                    }
                }
            }

            lastOrders = Object.values(lastOrdersMap);


            const findFailTx = (tonApiResult: any): boolean => {
                if (tonApiResult.transaction) {
                    if (tonApiResult.transaction.success === false) {
                        if (tonApiResult.transaction.in_msg.decoded_op_name !== "excess") {
                            return true;
                        }
                    }
                }
                if (tonApiResult.children) {
                    for (let child of tonApiResult.children) {
                        if (findFailTx(child)) return true;
                    }
                }
                return false;
            }

            for (const lastOrder of lastOrders) {
                if (lastOrder.type === 'executed') {
                    const transactionHashHex = Buffer.from(lastOrder.transactionHash, 'base64').toString('hex');
                    const result = await sendToTonApi('traces/' + transactionHashHex, {}, isTestnet);
                    if (findFailTx(result)) {
                        lastOrder.errorMessage = 'Failed';
                    }
                }
            }

            for (const lastOrder of lastOrders) {
                if (lastOrder.type === 'pending') {
                    try {
                        const orderInfo = await checkMultisigOrder(lastOrder.order.address, multisigOrderCode, multisigInfo, isTestnet, false, isExpertMode);
                        lastOrder.orderInfo = orderInfo;
                        const isExpired = (new Date()).getTime() > orderInfo.expiresAt.getTime();
                        if (isExpired) {
                            lastOrder.type = 'executed';
                        }
                    } catch (e) {
                        lastOrder.type = 'executed';
                        lastOrder.errorMessage = e.message;
                    }
                }
            }

            lastOrders = lastOrders.sort((a, b) => {
                if (a.type === b.type) {
                    return b.utime - a.utime;
                } else {
                    if (a.type === 'pending') return -1;
                    return 1;
                }
            });
        }
    }

    multisigInfo.lastOrders = lastOrders;

    return multisigInfo;
}