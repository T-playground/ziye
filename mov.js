
const APIKey = "mov";
$ = new API(APIKey, true);
if ($request) Listen();
function IdnMapping() {

    /** Highest positive signed 32-bit float value */
    var maxInt = 2147483647, // aka. 0x7FFFFFFF or 2^31-1

        /** Bootstring parameters */
        base = 36,
        tMin = 1,
        tMax = 26,
        skew = 38,
        damp = 700,
        initialBias = 72,
        initialN = 128, // 0x80
        delimiter = '-', // '\x2D'

        /** Regular expressions */
        regexPunycode = /^xn--/,
        regexNonASCII = /[^\x20-\x7E]/, // unprintable ASCII chars + non-ASCII chars
        regexSeparators = /[\x2E\u3002\uFF0E\uFF61]/g, // RFC 3490 separators

        /** Error messages */
        errors = {
            'overflow': 'Overflow: input needs wider integers to process',
            'not-basic': 'Illegal input >= 0x80 (not a basic code point)',
            'invalid-input': 'Invalid input'
        },

        /** Convenience shortcuts */
        baseMinusTMin = base - tMin,
        floor = Math.floor,
        stringFromCharCode = String.fromCharCode,

        /** Temporary variable */
        key;

    /*--------------------------------------------------------------------------*/

    /**
     * A generic error utility function.
     * @private
     * @param {String} type The error type.
     * @returns {Error} Throws a `RangeError` with the applicable error message.
     */
    function error(type) {
        throw RangeError(errors[type]);
    }

    /**
     * A generic `Array#map` utility function.
     * @private
     * @param {Array} array The array to iterate over.
     * @param {Function} callback The function that gets called for every array
     * item.
     * @returns {Array} A new array of values returned by the callback function.
     */
    function map(array, fn) {
        var length = array.length;
        var result = [];
        while (length--) {
            result[length] = fn(array[length]);
        }
        return result;
    }

    /**
     * A simple `Array#map`-like wrapper to work with domain name strings or email
     * addresses.
     * @private
     * @param {String} domain The domain name or email address.
     * @param {Function} callback The function that gets called for every
     * character.
     * @returns {Array} A new string of characters returned by the callback
     * function.
     */
    function mapDomain(string, fn) {
        var parts = string.split('@');
        var result = '';
        if (parts.length > 1) {
            // In email addresses, only the domain name should be punycoded. Leave
            // the local part (i.e. everything up to `@`) intact.
            result = parts[0] + '@';
            string = parts[1];
        }
        // Avoid `split(regex)` for IE8 compatibility. See #17.
        string = string.replace(regexSeparators, '\x2E');
        var labels = string.split('.');
        var encoded = map(labels, fn).join('.');
        return result + encoded;
    }

    /**
     * Creates an array containing the numeric code points of each Unicode
     * character in the string. While JavaScript uses UCS-2 internally,
     * this function will convert a pair of surrogate halves (each of which
     * UCS-2 exposes as separate characters) into a single code point,
     * matching UTF-16.
     * @see `punycode.ucs2.encode`
     * @memberOf punycode.ucs2
     * @name decode
     * @param {String} string The Unicode input string (UCS-2).
     * @returns {Array} The new array of code points.
     */
    function ucs2decode(string) {
        var output = [],
            counter = 0,
            length = string.length,
            value,
            extra;
        while (counter < length) {
            value = string.charCodeAt(counter++);
            if (value >= 0xD800 && value <= 0xDBFF && counter < length) {
                // high surrogate, and there is a next character
                extra = string.charCodeAt(counter++);
                if ((extra & 0xFC00) == 0xDC00) { // low surrogate
                    output.push(((value & 0x3FF) << 10) + (extra & 0x3FF) + 0x10000);
                } else {
                    // unmatched surrogate; only append this code unit, in case the next
                    // code unit is the high surrogate of a surrogate pair
                    output.push(value);
                    counter--;
                }
            } else {
                output.push(value);
            }
        }
        return output;
    }

    /**
     * Creates a string based on an array of numeric code points.
     * @see `punycode.ucs2.decode`
     * @memberOf punycode.ucs2
     * @name encode
     * @param {Array} codePoints The array of numeric code points.
     * @returns {String} The new Unicode string (UCS-2).
     */
    function ucs2encode(array) {
        return map(array,
            function (value) {
                var output = '';
                if (value > 0xFFFF) {
                    value -= 0x10000;
                    output += stringFromCharCode(value >>> 10 & 0x3FF | 0xD800);
                    value = 0xDC00 | value & 0x3FF;
                }
                output += stringFromCharCode(value);
                return output;
            }).join('');
    }

    /**
     * Converts a basic code point into a digit/integer.
     * @see `digitToBasic()`
     * @private
     * @param {Number} codePoint The basic numeric code point value.
     * @returns {Number} The numeric value of a basic code point (for use in
     * representing integers) in the range `0` to `base - 1`, or `base` if
     * the code point does not represent a value.
     */
    function basicToDigit(codePoint) {
        if (codePoint - 48 < 10) {
            return codePoint - 22;
        }
        if (codePoint - 65 < 26) {
            return codePoint - 65;
        }
        if (codePoint - 97 < 26) {
            return codePoint - 97;
        }
        return base;
    }

    /**
     * Converts a digit/integer into a basic code point.
     * @see `basicToDigit()`
     * @private
     * @param {Number} digit The numeric value of a basic code point.
     * @returns {Number} The basic code point whose value (when used for
     * representing integers) is `digit`, which needs to be in the range
     * `0` to `base - 1`. If `flag` is non-zero, the uppercase form is
     * used; else, the lowercase form is used. The behavior is undefined
     * if `flag` is non-zero and `digit` has no uppercase form.
     */
    function digitToBasic(digit, flag) {
        //  0..25 map to ASCII a..z or A..Z
        // 26..35 map to ASCII 0..9
        return digit + 22 + 75 * (digit < 26) - ((flag != 0) << 5);
    }

    /**
     * Bias adaptation function as per section 3.4 of RFC 3492.
     * http://tools.ietf.org/html/rfc3492#section-3.4
     * @private
     */
    function adapt(delta, numPoints, firstTime) {
        var k = 0;
        delta = firstTime ? floor(delta / damp) : delta >> 1;
        delta += floor(delta / numPoints);
        for (/* no initialization */; delta > baseMinusTMin * tMax >> 1; k += base) {
            delta = floor(delta / baseMinusTMin);
        }
        return floor(k + (baseMinusTMin + 1) * delta / (delta + skew));
    }

    /**
     * Converts a Punycode string of ASCII-only symbols to a string of Unicode
     * symbols.
     * @memberOf punycode
     * @param {String} input The Punycode string of ASCII-only symbols.
     * @returns {String} The resulting string of Unicode symbols.
     */
    function decode(input) {
        // Don't use UCS-2
        var output = [],
            inputLength = input.length,
            out,
            i = 0,
            n = initialN,
            bias = initialBias,
            basic,
            j,
            index,
            oldi,
            w,
            k,
            digit,
            t,
            /** Cached calculation results */
            baseMinusT;

        // Handle the basic code points: let `basic` be the number of input code
        // points before the last delimiter, or `0` if there is none, then copy
        // the first basic code points to the output.

        basic = input.lastIndexOf(delimiter);
        if (basic < 0) {
            basic = 0;
        }

        for (j = 0; j < basic; ++j) {
            // if it's not a basic code point
            if (input.charCodeAt(j) >= 0x80) {
                error('not-basic');
            }
            output.push(input.charCodeAt(j));
        }

        // Main decoding loop: start just after the last delimiter if any basic code
        // points were copied; start at the beginning otherwise.

        for (index = basic > 0 ? basic + 1 : 0; index < inputLength; /* no final expression */) {

            // `index` is the index of the next character to be consumed.
            // Decode a generalized variable-length integer into `delta`,
            // which gets added to `i`. The overflow checking is easier
            // if we increase `i` as we go, then subtract off its starting
            // value at the end to obtain `delta`.
            for (oldi = i, w = 1, k = base; /* no condition */; k += base) {

                if (index >= inputLength) {
                    error('invalid-input');
                }

                digit = basicToDigit(input.charCodeAt(index++));

                if (digit >= base || digit > floor((maxInt - i) / w)) {
                    error('overflow');
                }

                i += digit * w;
                t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);

                if (digit < t) {
                    break;
                }

                baseMinusT = base - t;
                if (w > floor(maxInt / baseMinusT)) {
                    error('overflow');
                }

                w *= baseMinusT;

            }

            out = output.length + 1;
            bias = adapt(i - oldi, out, oldi == 0);

            // `i` was supposed to wrap around from `out` to `0`,
            // incrementing `n` each time, so we'll fix that now:
            if (floor(i / out) > maxInt - n) {
                error('overflow');
            }

            n += floor(i / out);
            i %= out;

            // Insert `n` at position `i` of the output
            output.splice(i++, 0, n);

        }

        return ucs2encode(output);
    }

    /**
     * Converts a string of Unicode symbols (e.g. a domain name label) to a
     * Punycode string of ASCII-only symbols.
     * @memberOf punycode
     * @param {String} input The string of Unicode symbols.
     * @returns {String} The resulting Punycode string of ASCII-only symbols.
     */
    function encode(input) {
        var n,
            delta,
            handledCPCount,
            basicLength,
            bias,
            j,
            m,
            q,
            k,
            t,
            currentValue,
            output = [],
            /** `inputLength` will hold the number of code points in `input`. */
            inputLength,
            /** Cached calculation results */
            handledCPCountPlusOne,
            baseMinusT,
            qMinusT;

        // Convert the input in UCS-2 to Unicode
        input = ucs2decode(input);

        // Cache the length
        inputLength = input.length;

        // Initialize the state
        n = initialN;
        delta = 0;
        bias = initialBias;

        // Handle the basic code points
        for (j = 0; j < inputLength; ++j) {
            currentValue = input[j];
            if (currentValue < 0x80) {
                output.push(stringFromCharCode(currentValue));
            }
        }

        handledCPCount = basicLength = output.length;

        // `handledCPCount` is the number of code points that have been handled;
        // `basicLength` is the number of basic code points.

        // Finish the basic string - if it is not empty - with a delimiter
        if (basicLength) {
            output.push(delimiter);
        }

        // Main encoding loop:
        while (handledCPCount < inputLength) {

            // All non-basic code points < n have been handled already. Find the next
            // larger one:
            for (m = maxInt, j = 0; j < inputLength; ++j) {
                currentValue = input[j];
                if (currentValue >= n && currentValue < m) {
                    m = currentValue;
                }
            }

            // Increase `delta` enough to advance the decoder's <n,i> state to <m,0>,
            // but guard against overflow
            handledCPCountPlusOne = handledCPCount + 1;
            if (m - n > floor((maxInt - delta) / handledCPCountPlusOne)) {
                error('overflow');
            }

            delta += (m - n) * handledCPCountPlusOne;
            n = m;

            for (j = 0; j < inputLength; ++j) {
                currentValue = input[j];

                if (currentValue < n && ++delta > maxInt) {
                    error('overflow');
                }

                if (currentValue == n) {
                    // Represent delta as a generalized variable-length integer
                    for (q = delta, k = base; /* no condition */; k += base) {
                        t = k <= bias ? tMin : (k >= bias + tMax ? tMax : k - bias);
                        if (q < t) {
                            break;
                        }
                        qMinusT = q - t;
                        baseMinusT = base - t;
                        output.push(
                            stringFromCharCode(digitToBasic(t + qMinusT % baseMinusT, 0))
                        );
                        q = floor(qMinusT / baseMinusT);
                    }

                    output.push(stringFromCharCode(digitToBasic(q, 0)));
                    bias = adapt(delta, handledCPCountPlusOne, handledCPCount == basicLength);
                    delta = 0;
                    ++handledCPCount;
                }
            }

            ++delta;
            ++n;

        }
        return output.join('');
    }


    this.toUnicode = function (input) {
        return mapDomain(input,
            function (string) {
                return regexPunycode.test(string)
                    ? decode(string.slice(4).toLowerCase())
                    : string;
            });
    }


    this.toASCII = function (input) {
        return mapDomain(input,
            function (string) {
                return regexNonASCII.test(string)
                    ? 'xn--' + encode(string)
                    : string;
            });
    }


}

function Listen(){
    var idn = new IdnMapping();
    var str = idn.toUnicode($request.url);
    $.notify(str, "123", "结果：");
    $.done();
}


// prettier-ignore
function ENV(){const isQX=typeof $task!=="undefined";const isLoon=typeof $loon!=="undefined";const isSurge=typeof $httpClient!=="undefined"&&!isLoon;const isJSBox=typeof require=="function"&&typeof $jsbox!="undefined";const isNode=typeof require=="function"&&!isJSBox;const isRequest=typeof $request!=="undefined";const isScriptable=typeof importModule!=="undefined";return{isQX,isLoon,isSurge,isNode,isJSBox,isRequest,isScriptable}}
// prettier-ignore
function HTTP(baseURL,defaultOptions={}){const{isQX,isLoon,isSurge,isScriptable,isNode}=ENV();const methods=["GET","POST","PUT","DELETE","HEAD","OPTIONS","PATCH"];function send(method,options){options=typeof options==="string"?{url:options}:options;options.url=baseURL?baseURL+options.url:options.url;options={...defaultOptions,...options};const timeout=options.timeout;const events={...{onRequest:()=>{},onResponse:(resp)=>resp,onTimeout:()=>{},},...options.events,};events.onRequest(method,options);let worker;if(isQX){worker=$task.fetch({method,...options})}else if(isLoon||isSurge||isNode){worker=new Promise((resolve,reject)=>{const request=isNode?require("request"):$httpClient;request[method.toLowerCase()](options,(err,response,body)=>{if(err)reject(err);else resolve({statusCode:response.status||response.statusCode,headers:response.headers,body,})})})}else if(isScriptable){const request=new Request(options.url);request.method=method;request.headers=options.headers;request.body=options.body;worker=new Promise((resolve,reject)=>{request.loadString().then((body)=>{resolve({statusCode:request.response.statusCode,headers:request.response.headers,body,})}).catch((err)=>reject(err))})}let timeoutid;const timer=timeout?new Promise((_,reject)=>{timeoutid=setTimeout(()=>{events.onTimeout();return reject(`${method}URL:${options.url}exceeds the timeout ${timeout}ms`)},timeout)}):null;return(timer?Promise.race([timer,worker]).then((res)=>{clearTimeout(timeoutid);return res}):worker).then((resp)=>events.onResponse(resp))}const http={};methods.forEach((method)=>(http[method.toLowerCase()]=(options)=>send(method,options)));return http}
// prettier-ignore
function API(name="untitled",debug=false){const{isQX,isLoon,isSurge,isNode,isJSBox,isScriptable}=ENV();return new(class{constructor(name,debug){this.name=name;this.debug=debug;this.http=HTTP();this.env=ENV();this.node=(()=>{if(isNode){const fs=require("fs");return{fs}}else{return null}})();this.initCache();const delay=(t,v)=>new Promise(function(resolve){setTimeout(resolve.bind(null,v),t)});Promise.prototype.delay=function(t){return this.then(function(v){return delay(t,v)})}}initCache(){if(isQX)this.cache=JSON.parse($prefs.valueForKey(this.name)||"{}");if(isLoon||isSurge)this.cache=JSON.parse($persistentStore.read(this.name)||"{}");if(isNode){let fpath="root.json";if(!this.node.fs.existsSync(fpath)){this.node.fs.writeFileSync(fpath,JSON.stringify({}),{flag:"wx"},(err)=>console.log(err))}this.root={};fpath=`${this.name}.json`;if(!this.node.fs.existsSync(fpath)){this.node.fs.writeFileSync(fpath,JSON.stringify({}),{flag:"wx"},(err)=>console.log(err));this.cache={}}else{this.cache=JSON.parse(this.node.fs.readFileSync(`${this.name}.json`))}}}persistCache(){const data=JSON.stringify(this.cache);if(isQX)$prefs.setValueForKey(data,this.name);if(isLoon||isSurge)$persistentStore.write(data,this.name);if(isNode){this.node.fs.writeFileSync(`${this.name}.json`,data,{flag:"w"},(err)=>console.log(err));this.node.fs.writeFileSync("root.json",JSON.stringify(this.root),{flag:"w"},(err)=>console.log(err))}}write(data,key){this.log(`SET ${key}`);if(key.indexOf("#")!==-1){key=key.substr(1);if(isSurge||isLoon){return $persistentStore.write(data,key)}if(isQX){return $prefs.setValueForKey(data,key)}if(isNode){this.root[key]=data}}else{this.cache[key]=data}this.persistCache()}read(key){this.log(`READ ${key}`);if(key.indexOf("#")!==-1){key=key.substr(1);if(isSurge||isLoon){return $persistentStore.read(key)}if(isQX){return $prefs.valueForKey(key)}if(isNode){return this.root[key]}}else{return this.cache[key]}}delete(key){this.log(`DELETE ${key}`);if(key.indexOf("#")!==-1){key=key.substr(1);if(isSurge||isLoon){$persistentStore.write(null,key)}if(isQX){$prefs.removeValueForKey(key)}if(isNode){delete this.root[key]}}else{delete this.cache[key]}this.persistCache()}notify(title,subtitle="",content="",options={}){const openURL=options["open-url"];const mediaURL=options["media-url"];if(isQX)$notify(title,subtitle,content,options);if(isSurge){$notification.post(title,subtitle,content+`${mediaURL?"\n多媒体:"+mediaURL:""}`,{url:openURL})}if(isLoon){let opts={};if(openURL)opts["openUrl"]=openURL;if(mediaURL)opts["mediaUrl"]=mediaURL;if(JSON.stringify(opts)=="{}"){$notification.post(title,subtitle,content)}else{$notification.post(title,subtitle,content,opts)}}if(isNode||isScriptable){const content_=content+(openURL?`\n点击跳转:${openURL}`:"")+(mediaURL?`\n多媒体:${mediaURL}`:"");if(isJSBox){const push=require("push");push.schedule({title:title,body:(subtitle?subtitle+"\n":"")+content_,})}else{console.log(`${title}\n${subtitle}\n${content_}\n\n`)}}}log(msg){if(this.debug)console.log(msg)}info(msg){console.log(msg)}error(msg){console.log("ERROR: "+msg)}wait(millisec){return new Promise((resolve)=>setTimeout(resolve,millisec))}done(value={}){if(isQX||isLoon||isSurge){$done(value)}else if(isNode&&!isJSBox){if(typeof $context!=="undefined"){$context.headers=value.headers;$context.statusCode=value.statusCode;$context.body=value.body}}}})(name,debug)}
