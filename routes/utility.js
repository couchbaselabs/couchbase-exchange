const Bitcore = require("bitcore-lib");
const Mnemonic = require("bitcore-mnemonic");

module.exports = (app) => {

    app.get("/mnemonic", (request, response) => {
        response.send({
            "mnemonic": (new Mnemonic(Mnemonic.Words.ENGLISH)).toString()
        });
    });

    app.get("/balance/value", (request, response) => {
        Request("https://api.coinmarketcap.com/v1/ticker/bitcoin/").then(market => {
            response.send({ "value": "$" + (JSON.parse(market)[0].price_usd * request.query.balance).toFixed(2) });
        }, error => {
            response.status(500).send(error);
        });
    });

}
