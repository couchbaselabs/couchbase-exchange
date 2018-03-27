const Couchbase = require("couchbase");
const Request = require("request-promise");
const UUID = require("uuid");
const Bitcore = require("bitcore-lib");

class Helper {

    constructor(host, bucket, username, password, seed) {
        this.cluster = new Couchbase.Cluster("couchbase://" + host);
        this.cluster.authenticate(username, password);
        this.bucket = this.cluster.openBucket(bucket);
        this.master = seed;
    }

    createKeyPair(account) {
        var account = this.master.deriveChild(account);
        var key = account.deriveChild(Math.random() * 10000 + 1);
        return { "secret": key.privateKey.toWIF().toString(), "address": key.privateKey.toAddress().toString() }
    }

    getWalletBalance(addresses) {
        var promises = [];
        for(var i = 0; i < addresses.length; i++) {
            promises.push(Request("https://insight.bitpay.com/api/addr/" + addresses[i]));
        }
        return Promise.all(promises).then(result => {
            var balance = result.reduce((a, b) => a + JSON.parse(b).balanceSat, 0);
            return new Promise((resolve, reject) => {
                resolve({ "balance": balance });
            });
        });
    }

    getAddressBalance(address) {
        return Request("https://insight.bitpay.com/api/addr/" + address);
    }

    getAddressUtxo(address) {
        return Request("https://insight.bitpay.com/api/addr/" + address + "/utxo").then(utxo => {
            return new Promise((resolve, reject) => {
                if(JSON.parse(utxo).length == 0) {
                    reject({ "message": "There are no unspent transactions available." });
                }
                resolve(JSON.parse(utxo));
            });
        });
    }

    insert(data, id = UUID.v4()) {
        return new Promise((resolve, reject) => {
            this.bucket.insert(id, data, (error, result) => {
                if(error) {
                    reject({ "code": error.code, "message": error.message });
                }
                data.id = id;
                resolve(data);
            });
        });
    }

    createAccount(data) {
        return new Promise((resolve, reject) => {
            this.bucket.counter("accounts::total", 1, { "initial": 1 }, (error, result) => {
                if(error) {
                    reject({ "code": error.code, "message": error.message });
                }
                data.account = result.value;
                this.insert(data).then(result => {
                    resolve(result);
                }, error => {
                    reject(error);
                });
            });
        });
    }

    addAddress(account) {
        return new Promise((resolve, reject) => {
            this.bucket.get(account, (error, result) => {
                if(error) {
                    reject({ "code": error.code, "message": error.message });
                }
                var keypair = this.createKeyPair(result.value.account);
                this.bucket.mutateIn(account).arrayAppend("addresses", keypair, true).execute((error, result) => {
                    if(error) {
                        reject({ "code": error.code, "message": error.message });
                    }
                    resolve({ "address": keypair.address });
                });
            });
        });
    }

    getAccountBalance(account) {
        var statement = "SELECT SUM(tx.satoshis) AS balance FROM " + this.bucket._name + " AS tx WHERE tx.type = 'transaction' AND tx.account = $account";
        var query = Couchbase.N1qlQuery.fromString(statement);
        return new Promise((resolve, reject) => {
            this.bucket.query(query, { "account": account }, (error, result) => {
                if(error) {
                    reject({ "code": error.code, "message": error.message });
                }
                resolve({ "balance": result[0].balance });
            });
        });
    }

    getMasterAddresses() {
        var addresses = [];
        var account = this.master.deriveChild(0);
        for(var i = 1; i <= 10; i++) {
            addresses.push(account.deriveChild(i).privateKey.toAddress().toString());
        }
        return addresses;
    }

    getMasterKeyPairs() {
        var keypairs = [];
        var key;
        var account = this.master.deriveChild(0);
        for(var i = 1; i <= 10; i++) {
            key = account.deriveChild(i);
            keypairs.push({ "secret": key.privateKey.toWIF().toString(), "address": key.privateKey.toAddress().toString() });
        }
        return keypairs;
    }

    getMasterAddressWithMinimum(addresses, amount) {
        var promises = [];
        for(var i = 0; i < addresses.length; i++) {
            promises.push(Request("https://insight.bitpay.com/api/addr/" + addresses[i]));
        }
        return Promise.all(promises).then(result => {
            for(var i = 0; i < result.length; i++) {
                if(result[i].balanceSat >= amount) {
                    return resolve({ "address": result[i].addrStr });
                }
            }
            reject({ "message": "Not enough funds in exchange" });
        });
    }

    getMasterChangeAddress() {
        var account = this.master.deriveChild(0);
        var key = account.deriveChild(Math.random() * 10 + 1);
        return { "secret": key.privateKey.toWIF().toString(), "address": key.privateKey.toAddress().toString() }
    }

    getAddresses(account) {
        var statement, params;
        if(account) {
            statement = "SELECT VALUE addresses.address FROM " + this.bucket._name + " AS account USE KEYS $id UNNEST account.addresses as addresses";
            params = { "id": account };
        } else {
            statement = "SELECT VALUE addresses.address FROM " + this.bucket._name + " AS account UNNEST account.addresses as addresses WHERE account.type = 'account'";
        }
        var query = Couchbase.N1qlQuery.fromString(statement);
        return new Promise((resolve, reject) => {
            this.bucket.query(query, params, (error, result) => {
                if(error) {
                    reject({ "code": error.code, "message": error.message });
                }
                resolve(result);
            });
        });
    }

    getPrivateKeyFromAddress(account, address) {
        var statement = "SELECT VALUE keypairs.secret FROM " + this.bucket._name + " AS account USE KEYS $account UNNEST account.addresses AS keypairs WHERE keypairs.address = $address";
        var query = Couchbase.N1qlQuery.fromString(statement);
        return new Promise((resolve, reject) => {
            this.bucket.query(query, { "account": account, "address": address }, (error, result) => {
                if(error) {
                    reject({ "code": error.code, "message": error.message });
                }
                resolve({ "secret": result[0] });
            });
        });
    }

    createTransactionFromAccount(account, source, destination, amount) {
        return new Promise((resolve, reject) => {
            this.getAddressBalance(source).then(sourceAddress => {
                if(sourceAddress.balanceSat < amount) {
                    return reject({ "message": "Not enough funds in account." });
                }
                this.getPrivateKeyFromAddress(account, source).then(keypair => {
                    this.getAddressUtxo(source).then(utxo => {
                        var transaction = new Bitcore.Transaction();
                        for(var i = 0; i < utxo.length; i++) {
                            transaction.from(utxo[i]);
                        }
                        transaction.to(destination, amount);
                        this.addAddress(account).then(change => {
                            transaction.change(change.address);
                            transaction.sign(keypair.secret);
                            resolve(transaction);
                        }, error => reject(error));
                    }, error => reject(error));
                }, error => reject(error));
            }, error => reject(error));
        });
    }

    createTransactionFromMaster(account, destination, amount) {
        return new Promise((resolve, reject) => {
            this.getAccountBalance(account).then(accountBalance => {
                if(accountBalance.balance < amount) {
                    reject({ "message": "Not enough funds in account." });
                }
                var mKeyPairs = this.getMasterKeyPairs();
                var masterAddresses = mKeyPairs.map(a => a.address);
                this.getMasterAddressWithMinimum(masterAddresses, amount).then(funds => {
                    this.getAddressUtxo(funds.address).then(utxo => {
                        var transaction = new Bitcore.Transaction();
                        for(var i = 0; i < utxo.length; i++) {
                            transaction.from(utxo[i]);
                        }
                        transaction.to(destination, amount);
                        var change = helper.getMasterChangeAddress();
                        transaction.change(change.address);
                        for(var j = 0; j < mKeyPairs.length; j ++) {
                            if(mKeyPairs[j].address == funds.address) {
                                transaction.sign(mKeyPairs[j].secret);
                            }
                        }
                        var tx = {
                            account: account,
                            satoshis: (amount * -1),
                            timestamp: (new Date()).getTime(),
                            status: "transfer",
                            type: "transaction"
                        };
                        this.insert(tx).then(result => {
                            resolve(transaction);
                        }, error => reject(error));
                    }, error => reject(error));
                }, error => reject(error));
            }, error => reject(error));
        });
    }

}

module.exports = Helper;
