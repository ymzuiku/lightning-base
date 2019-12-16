'use strict';

Object.defineProperty(exports, '__esModule', { value: true });

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var mongodb = require('mongodb');
var fastify = _interopDefault(require('fastify'));
var fastifyCors = _interopDefault(require('fastify-cors'));
var lodash = require('lodash');
var crypto = _interopDefault(require('crypto'));
var NodeRSA = _interopDefault(require('node-rsa'));
var fs = _interopDefault(require('fs-extra'));
var path = require('path');

const db = (dbName) => db.getDb(dbName);
db.defaultDbName = '';
db.getDb = (dbName = db.defaultDbName) => null;
db.inited = false;
db.init = (uri = 'mongodb://127.0.0.1:27017', defaultDbName = 'test') => {
    if (db.inited) {
        return;
    }
    db.inited = true;
    db.defaultDbName = defaultDbName;
    return new Promise(res => {
        mongodb.MongoClient.connect(uri, {
            // useFindAndModify: false,
            useNewUrlParser: true,
            useUnifiedTopology: true,
        }).then(client => {
            db.getDb = dbName => client.db(dbName || db.defaultDbName);
            res();
        });
    });
};

const app = fastify({
    logger: true,
    disableRequestLogging: true,
});
const setCors = () => app.register(fastifyCors);

const sha256 = (str, slat) => {
    const obj = crypto.createHash('sha256');
    obj.update(str + (slat ? slat : ''));
    return obj.digest('hex');
};

const createRSA = () => {
    const RSA = {
        priateKey: null,
        publicKey: null,
        init: keyData => {
            let [a, b] = keyData.split('-----END PUBLIC KEY-----');
            a += `-----END PUBLIC KEY-----`;
            RSA.publicKey = new NodeRSA({ b: 512 });
            RSA.priateKey = new NodeRSA({ b: 512 });
            RSA.publicKey.importKey(a, 'public');
            RSA.priateKey.importKey(b, 'private');
            RSA.publicKey.setOptions({ encryptionScheme: 'pkcs1' });
            RSA.priateKey.setOptions({ encryptionScheme: 'pkcs1' });
        },
        createKeys: () => {
            const client = new NodeRSA({ b: 512 });
            const clientPublic = client.exportKey('public');
            const clientPrivate = client.exportKey('private');
            const server = new NodeRSA({ b: 512 });
            const serverPublic = server.exportKey('public');
            const serverPrivate = server.exportKey('private');
            return {
                client: serverPublic + '\n' + clientPrivate,
                server: clientPublic + '\n' + serverPrivate,
                baseClient: clientPublic + '\n' + clientPrivate,
                baseServer: serverPublic + '\n' + serverPrivate,
            };
        },
        decode: (text) => {
            if (!RSA.publicKey) {
                return text;
            }
            return RSA.publicKey.decryptPublic(text, 'utf8');
        },
        encode: (text) => {
            if (typeof text !== 'string') {
                text = JSON.stringify(text);
            }
            if (!RSA.publicKey) {
                return text;
            }
            return RSA.priateKey.encryptPrivate(text, 'base64');
        },
    };
    return RSA;
};

const canUseMethod = new Set([
    'insert',
    'insertMany',
    'insertOne',
    'deleteOne',
    'update',
    'updateMany',
    'updateOne',
    'replaceOne',
    'find',
    'findOne',
]);
const serverless = async (options) => {
    const { url = '/less', checkKey, checkTime, impose = {}, blockDb: theBlockDb, blockCol: theBlockCol, autoRSA, RSAKey, } = options;
    const blockDb = new Set(['lightning', ...(theBlockDb || [])]);
    const blockCol = new Set([...(theBlockCol || [])]);
    let RSA = createRSA();
    if (RSAKey) {
        RSA.init(RSAKey);
    }
    else if (autoRSA) {
        const col = db('lightning').collection('rsa');
        const old = await col.findOne({ name: { $eq: autoRSA } });
        let clientKey = '';
        if (!old) {
            const keys = RSA.createKeys();
            clientKey = keys.client;
            RSA.init(old.server);
            await col.insertOne({
                name: autoRSA,
                ...keys,
            });
        }
        else {
            clientKey = old.client;
            RSA.init(old.server);
        }
        let errorGetAutoRSANumber = 0;
        app.get('/lightning/rsa', async (req, rep) => {
            if (errorGetAutoRSANumber >= 5) {
                return rep.send('error times');
            }
            // 如果查询请求连续5次错误，限制15分钟查询时间
            if (req.query.name !== autoRSA) {
                errorGetAutoRSANumber += 1;
                if (errorGetAutoRSANumber >= 5) {
                    setTimeout(() => {
                        errorGetAutoRSANumber = 0;
                    }, 1000 * 60 * 60);
                }
                return rep.send(req.query);
            }
            return rep.send(clientKey);
        });
    }
    app.post(url, async (req, rep) => {
        if (!req.body || !req.body.code) {
            return rep.status(400).send(new Error('body or body.code is empty'));
        }
        const realData = JSON.parse(RSA.decode(req.body.code));
        if (checkTime) {
            const nowTime = Date.now();
            if (realData._checkTime < nowTime - checkTime || realData._checkTime > nowTime + checkTime) {
                return rep.status(400).send(new Error('no permission[1]!'));
            }
        }
        if (checkKey) {
            if (realData._checkKey !== checkKey) {
                return rep.status(400).send(new Error('no permission[2]!'));
            }
        }
        const body = realData.events ? realData.events : [realData];
        let nowEvent = 0;
        const recall = async () => {
            // 如果 event 溢出
            if (nowEvent > body.length - 1) {
                return rep.status(500).send(new Error('event is out'));
            }
            // 计算是否是最后一个
            let isNeedSend = false;
            if (nowEvent === body.length - 1) {
                isNeedSend = true;
            }
            let { db: dbName = 'test', col: colName = 'test', block, method, args = [], argsSha256, argsObjectId, remove, } = body[nowEvent];
            if (blockDb && blockDb.has(dbName)) {
                return rep.status(400).send(new Error('no permission[3]!'));
            }
            if (blockCol && blockCol.has(colName)) {
                return rep.status(400).send(new Error('no permission[4]!'));
            }
            if (!canUseMethod.has(method)) {
                return rep.status(400).send(new Error(`can not use "${method}" method`));
            }
            const col = db(dbName).collection(colName);
            if (argsSha256) {
                argsSha256.forEach((p) => {
                    const value = lodash.get(args, p);
                    if (value) {
                        lodash.set(args, p, sha256(value));
                    }
                });
            }
            if (argsObjectId) {
                argsObjectId.forEach((id) => {
                    const value = lodash.get(args, id);
                    if (value) {
                        lodash.set(args, id, new mongodb.ObjectId(value));
                    }
                });
            }
            // 处理参数和限制权限
            if (method.indexOf('update') > -1 || method.indexOf('delete') > -1) {
                const filter = impose[colName] && impose[colName].filter;
                if (filter) {
                    let isLockerError = true;
                    for (let i = 0; i < filter.length; i++) {
                        const key = filter[i];
                        if (typeof key === 'string') {
                            const value = lodash.get(args[0], key);
                            if (value) {
                                isLockerError = false;
                                break;
                            }
                        }
                        else {
                            let isHaveValue = 0;
                            for (let j = 0; j < key.length; j++) {
                                const subKey = key[j];
                                const value = lodash.get(args[0], subKey);
                                if (value) {
                                    isHaveValue += 1;
                                }
                            }
                            if (isHaveValue === key.length) {
                                isLockerError = false;
                                break;
                            }
                        }
                    }
                    if (isLockerError) {
                        return rep.status(400).send(new Error(`locker: master filter use ${JSON.stringify(filter)}`));
                    }
                }
            }
            let data = await col[method](...args);
            if (method === 'find') {
                data = data.toArray();
            }
            if (block) {
                if (!data) {
                    return rep.status(400).send(new Error('block: data void'));
                }
                const keys = Object.keys(block);
                let blockError = null;
                for (let i = 0; i < keys.length; i++) {
                    const key = keys[i];
                    const value = block[key];
                    if (lodash.get(data, key) !== block[key]) {
                        blockError = new Error(`block: ${key} is not ${value}`);
                        break;
                    }
                }
                if (blockError) {
                    return rep.status(400).send(blockError);
                }
            }
            if (!isNeedSend) {
                nowEvent += 1;
                await recall();
                return;
            }
            if (!data) {
                return rep.status(200).send({ code: RSA.encode({ mes: 'data is empty' }) });
            }
            if (data) {
                const { connection, message, ...sendData } = data;
                // 提出不需要返回的
                const allTrim = new Set([...(remove || []), ...((impose[colName] && impose[colName].remove) || [])]);
                allTrim.forEach(key => {
                    lodash.set(sendData, key, undefined);
                });
                return rep.status(200).send({ code: RSA.encode(sendData) });
            }
        };
        await recall();
    });
};

const controllersLoader = (dir, indexOf, params) => {
    const files = fs.readdirSync(dir);
    files.forEach((file) => {
        const nextDir = path.resolve(dir, file);
        const stat = fs.statSync(nextDir);
        if (stat && stat.isDirectory()) {
            controllersLoader(nextDir, indexOf);
        }
        else if (file.indexOf(indexOf) > 0) {
            const ctrl = require(nextDir);
            if (typeof ctrl === 'function') {
                ctrl(params);
            }
        }
    });
};

exports.app = app;
exports.controllersLoader = controllersLoader;
exports.createRSA = createRSA;
exports.db = db;
exports.serverless = serverless;
exports.setCors = setCors;
exports.sha256 = sha256;
