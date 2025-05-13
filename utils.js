const fs = require('fs');

// Utility function to delete file
function delfile(filepath) {
  fs.unlink(filepath, () => {
    console.log(`File ${filepath} has been successfully removed.`);
  });
}

module.exports = {
  delfile
};