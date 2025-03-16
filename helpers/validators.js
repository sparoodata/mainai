function isValidName(name) {
  const regex = /^[a-zA-Z0-9 ]+$/;
  return (
    typeof name === 'string' &&
    name.trim().length > 0 &&
    name.length <= 40 &&
    regex.test(name)
  );
}

function isValidAddress(address) {
  const regex = /^[a-zA-Z0-9 ]+$/;
  return (
    typeof address === 'string' &&
    address.trim().length > 0 &&
    address.length <= 40 &&
    regex.test(address)
  );
}

function isValidUnits(units) {
  const num = parseInt(units);
  return !isNaN(num) && num > 0 && Number.isInteger(num);
}

function isValidTotalAmount(amount) {
  const num = parseFloat(amount);
  return !isNaN(num) && num > 0;
}

function isValidDate(dateStr) {
  const regex = /^(\d{2})-(\d{2})-(\d{4})$/;
  if (!regex.test(dateStr)) return false;
  const [day, month, year] = dateStr.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  return (
    date.getDate() === day &&
    date.getMonth() === month - 1 &&
    date.getFullYear() === year
  );
}

module.exports = {
  isValidName,
  isValidAddress,
  isValidUnits,
  isValidTotalAmount,
  isValidDate,
};
