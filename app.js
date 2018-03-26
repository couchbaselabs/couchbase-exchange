const Express = require("express");
const Couchbase = require("couchbase");
const BodyParser = require("body-parser");
const UUID = require("uuid");
const Request = require("request-promise");
const Joi = require("joi");
const Bitcore = require("bitcore-lib");
const Mnemonic = require("bitcore-mnemonic");
const Config = require("./config");

var app = Express();

app.use(BodyParser.json());
app.use(BodyParser.urlencoded({ extended: true }));

var mnemonic = new Mnemonic(Config.mnemonic);
var master = new Bitcore.HDPrivateKey(mnemonic.toHDPrivateKey());

var cluster = new Couchbase.Cluster("couchbase://" + Config.host);
cluster.authenticate(Config.username, Config.password);
var bucket = cluster.openBucket(Config.bucket);

app.get("/mnemonic", (request, response) => {
    response.send({
        "mnemonic": (new Mnemonic(Mnemonic.Words.ENGLISH)).toString()
    });
});

app.post("/account", (request, response) => {
    var model = Joi.object().keys({
        firstname: Joi.string().required(),
        lastname: Joi.string().required(),
        type: Joi.string().forbidden().default("account")
    });
    Joi.validate(request.body, model, { stripUnknown: true }, (error, value) => {
        if(error) {
            return response.status(500).send(error);
        }
        var id = UUID.v4();
        bucket.counter("accounts::total", 1, { "initial": 1 }, (error, result) => {
            if(error) {
                return response.status(500).send({ "code": error.code, "message": error.message });
            }
            value.account = result.value;
            bucket.insert(id, value, (error, result) => {
                if(error) {
                    return response.status(500).send({ "code": error.code, "message": error.message });
                }
                response.send(value);
            });
        });
    });
});

app.put("/account/address/:id", (request, response) => {
    bucket.counter(request.params.id + "::addresses", 1, { "initial": 1 }, (error, result) => {
        if(error) {
            return response.status(500).send({ "code": error.code, "message": error.message });
        }
        bucket.get(request.params.id, (error, account) => {
            if(error) {
                return response.status(500).send({ "code": error.code, "message": error.message });
            }
            var account = master.deriveChild(account.value.account);
            var key = account.deriveChild(result.value);
            bucket.mutateIn(request.params.id).arrayAppend("addresses", { "secret": key.privateKey.toWIF().toString(), "address": key.privateKey.toAddress().toString() }, true).execute((error, result) => {
                if(error) {
                    return response.status(500).send({ "code": error.code, "message": error.message });
                }
                response.send({ "address": key.privateKey.toAddress().toString() });
            });
        });
    });
});

app.get("/account/addresses/:id", (request, response) => {
    var statement = "SELECT VALUE addresses.address FROM " + bucket._name + " AS account USE KEYS $id UNNEST account.addresses as addresses";
    var query = Couchbase.N1qlQuery.fromString(statement);
    bucket.query(query, { "id": request.params.id }, (error, result) => {
        if(error) {
            return response.status(500).send({ "code": error.code, "message": error.message });
        }
        response.send(result);
    });
});

app.get("/addresses", (request, response) => {
    var statement = "SELECT VALUE addresses.address FROM " + bucket._name + " AS account UNNEST account.addresses as addresses WHERE account.type = 'account'";
    var query = Couchbase.N1qlQuery.fromString(statement);
    bucket.query(query, (error, result) => {
        if(error) {
            return response.status(500).send({ "code": error.code, "message": error.message });
        }
        response.send(result);
    });
});

app.get("/account/balance/:id", (request, response) => {
    var statement = "SELECT VALUE addresses.address FROM " + bucket._name + " AS account USE KEYS $id UNNEST account.addresses as addresses";
    var query = Couchbase.N1qlQuery.fromString(statement);
    bucket.query(query, { "id": request.params.id }, (error, result) => {
        if(error) {
            return response.status(500).send({ "code": error.code, "message": error.message });
        }
        var promises = []
        for(var i = 0; i < result.length; i++) {
            promises.push(Request("https://insight.bitpay.com/api/addr/" + result[i]));
        }
        Promise.all(promises).then(result => {
            var balance = result.reduce((a, b) => a + JSON.parse(b).balanceSat, 0);
            response.send({ "balance": balance });
        }, error => {
            return response.status(500).send(error);
        });
    });
});

app.get("/balance/value", (request, response) => {
    Request("https://api.coinmarketcap.com/v1/ticker/bitcoin/").then(market => {
        response.send({ "value": "$" + (JSON.parse(market)[0].price_usd * request.query.balance).toFixed(2) });
    }, error => {
        response.status(500).send(error);
    });
});

app.post("/withdraw", (request, response) => {
    var model = Joi.object().keys({
        satoshis: Joi.number().required(),
        id: Joi.string().required()
    });
    Joi.validate(request.body, model, { stripUnknown: true }, (error, value) => {
        if(error) {
            return response.status(500).send(error);
        }
        var statement = "SELECT SUM(tx.satoshis) AS balance FROM " + bucket._name + " AS tx WHERE tx.type = 'transaction' AND tx.account = $account";
        var query = Couchbase.N1qlQuery.fromString(statement);
        bucket.query(query, { "account": value.id }, (error, result) => {
            if(error) {
                return response.status(500).send({ "code": error.code, "message": error.message });
            } else if(result[0].balance == null || (result[0].balance - value.satoshis) < 0) {
                return response.status(500).send({ "message": "There are not `" + value.satoshis + "` satoshis available for withdrawal" });
            }
            var id = UUID.v4();
            Request("https://api.coinmarketcap.com/v1/ticker/bitcoin/").then(market => {
                var usd = (Bitcore.Unit.fromSatoshis(value.satoshis).toBTC() * JSON.parse(market)[0].price_usd).toFixed(2);
                var transaction = {
                    account: value.id,
                    satoshis: (value.satoshis * -1),
                    usd: parseFloat(usd),
                    timestamp: (new Date()).getTime(),
                    status: "withdrawal",
                    type: "transaction"
                };
                bucket.insert(id, transaction, (error, result) => {
                    if(error) {
                        return response.status(500).send({ "code": error.code, "message": error.message });
                    }
                    transaction.id = id;
                    response.send(transaction);
                });
            }, error => {
                response.status(500).send(error);
            });
        });
    });
});

app.post("/deposit", (request, response) => {
    var model = Joi.object().keys({
        usd: Joi.number().required(),
        id: Joi.string().required()
    });
    Joi.validate(request.body, model, { stripUnknown: true }, (error, value) => {
        if(error) {
            return response.status(500).send(error);
        }
        var id = UUID.v4();
        Request("https://api.coinmarketcap.com/v1/ticker/bitcoin/").then(market => {
            var btc = value.usd / JSON.parse(market)[0].price_usd;
            var transaction = {
                account: value.id,
                usd: value.usd,
                satoshis: Bitcore.Unit.fromBTC(btc).toSatoshis(),
                timestamp: (new Date()).getTime(),
                status: "deposit",
                type: "transaction"
            };
            bucket.insert(id, transaction, (error, result) => {
                if(error) {
                    return response.status(500).send({ "code": error.code, "message": error.message });
                }
                transaction.id = id;
                response.send(transaction);
            });
        }, error => {
            response.status(500).send(error);
        });
    });
});

app.post("/transfer", (request, response) => {

});

app.post("/cashout", (request, response) => {
    var model = Joi.object().keys({
        amount: Joi.number().required(),
        id: Joi.string().required()
    });
    Joi.validate(request.body, model, { stripUnknown: true }, (error, value) => {
        if(error) {
            return response.status(500).send(error);
        }
        var statement = "SELECT VALUE addresses FROM " + bucket._name + " AS account USE KEYS $id UNNEST account.addresses as addresses";
        var query = Couchbase.N1qlQuery.fromString(statement);
        bucket.query(query, { "id": value.id }, (error, addresses) => {
            if(error) {
                return response.status(500).send({ "code": error.code, "message": error.message });
            }
            var promises = [];
            for(var i = 0; i < addresses.length; i++) {
                promises.push(Request("https://insight.bitpay.com/api/addr/" + addresses[i].address + "/utxo"));
            }
            Promise.all(promises).then(utxos => {
                var transaction = new Bitcore.Transaction();
                var hasUTXO = false;
                for(var j = 0; j < utxos.length; j++) {
                    if(JSON.parse(utxos[j]).length == 0) {
                        break;
                    }
                    hasUTXO = true;
                    for(var k = 0; k < JSON.parse(utxos[j]).length; k++) {
                        transaction.from(JSON.parse(utxos[j])[k]);
                    }
                }
                if(!hasUTXO) {
                    return response.status(500).send({ "message": "The source addresses have no unspent transactions" });
                }
                transaction.to("3B6dg2MuTvBJmCcFz3os3icGiMGQz2fFy1", value.amount);
                response.send(transaction);
            });
        });
    });
});

var server = app.listen(3000, () => {
    console.log("Listening at :" + server.address().port + "...");
});
