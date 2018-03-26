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

}

module.exports = Helper;
