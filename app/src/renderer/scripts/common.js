module.exports.sleep = function(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
// if given a valid address this will return the prefix plus some parameter
// length of the end. if it is not an address it will take that parameter
// length and return half of it as the beginning of the "address" and hald the end
module.exports.shortAddress = function(address, length = 4) {
  if (address.indexOf("1") === -1) {
    return address.length <= length
      ? address
      : address.slice(0, Math.floor(length / 2)) +
          "…" +
          address.slice(-1 * Math.ceil(length / 2))
  } else {
    if (length > address.split("1")[1].length) return address
    return address.split("1")[0] + "…" + address.slice(-1 * length)
  }
}
