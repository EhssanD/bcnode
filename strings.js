
var crypto = require('crypto'); 
var uuid = require('node-uuid');
var btoa = require('btoa');

var strings = {

    sha: function(str){

        if(str == undefined || str.constructor != String){
            return Error("failed to create sha of string");
        }
        return crypto.createHash("sha1").update(str).digest('hex');

    }, 

	uuid: function(){
		return uuid.v4();
	},

	randomSha: function(){
		return crypto.createHash("sha1").update(uuid.v4()).digest("hex");
	},

 	stringToUint: function(string) {
		var string = btoa(unescape(encodeURIComponent(string))),
			charList = string.split(''),
			uintArray = [];
		for (var i = 0; i < charList.length; i++) {
			uintArray.push(charList[i].charCodeAt(0));
		}
		return new Uint8Array(uintArray);
	},

	uintToString: function(uintArray) {
		var encodedString = String.fromCharCode.apply(null, uintArray),
			decodedString = decodeURIComponent(escape(atob(encodedString)));
		return decodedString;
	},

	randomHash: function(howMany, chars) {

		chars = chars 
			|| "abcdefghijklmnopqrstuwxyzABCDEFGHIJKLMNOPQRSTUWXYZ0123456789";
		var rnd = crypto.randomBytes(howMany)
			, value = new Array(howMany)
			, len = chars.length;

		for (var i = 0; i < howMany; i++) {
			value[i] = chars[rnd[i] % len]
		};

		return value.join('');

	}

}

module.exports = strings;
