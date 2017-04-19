var fs = require('fs')
var crypto = require('crypto')
var createCommonClient = require('./lib/create-common-client.js')

var commonClient
var currentVersion
var targetVersion
var migrations = [] // array of objects like: {version: n, action: 'do', direction: 'up', filename: '0001.up.sql'}

var config = {}

exports.config = config

/*  Set Config
================================================================= */
exports.setConfig = function (configuration) {
  config = configuration
  config.schemaTable = config.schemaTable || 'schemaversion'
  config.logProgress = config.logProgress != null ? config.logProgress : true

  commonClient = createCommonClient(config)
}

/*  Migration Sorting Functions
================================================================= */
var sortMigrationsAsc = function (a, b) {
  if (a.version < b.version) { return -1 }
  if (a.version > b.version) { return 1 }
  return 0
}

var sortMigrationsDesc = function (a, b) {
  if (a.version < b.version) { return 1 }
  if (a.version > b.version) { return -1 }
  return 0
}

/*
  getMigrations()

  Internal function
  Reads the migration directory for all the migration files.
  It is SYNC out of laziness and simplicity
================================================================= */
var getMigrations = function () {
  migrations = []
  var migrationFiles = fs.readdirSync(config.migrationDirectory)
  migrationFiles.forEach(function (file) {
    var m = file.split('.')
    var name = m.length >= 3 ? m.slice(2, m.length - 1).join('.') : file
    if (m[m.length - 1] === 'sql') {
      migrations.push({
        version: Number(m[0]),
        direction: m[1],
        action: m[1],
        filename: file,
        name: name,
        md5: fileChecksum(config.migrationDirectory + '/' + file, config.newline)
      })
    }
  })
}

/*
  runQuery

  connects the database driver if it is not currently connected.
  Executes an arbitrary sql query using the common client
================================================================= */
function runQuery (query, cb) {
  if (commonClient.connected) {
    commonClient.runQuery(query, cb)
  } else {
    commonClient.createConnection(function (err) {
      if (err) cb(err)
      else {
        commonClient.connected = true
        commonClient.runQuery(query, cb)
      }
    })
  }
}
exports.runQuery = runQuery

/*
  endConnection
  Ends the commonClient's connection to the database
================================================================= */
function endConnection (cb) {
  if (commonClient.connected) {
    commonClient.endConnection(function () {
      commonClient.connected = false
      cb()
    })
  } else {
    cb()
  }
}
exports.endConnection = endConnection

/*
  getCurrentVersion(callback)

  Internal & External function
  Gets the current version of the schema from the database.
================================================================= */
var getCurrentVersion = function (callback) {
  runQuery(commonClient.queries.getCurrentVersion, function (err, result) {
    if (err) { // means the table probably doesn't exist yet. To lazy to check.
      console.error('something went wrong getting the Current Version from the ' + config.schemaTable + ' table')
    } else {
      if (result.rows.length > 0) currentVersion = result.rows[0].version
      else currentVersion = 0
    }
    callback(err, currentVersion)
  })
}
exports.getCurrentVersion = getCurrentVersion

/*
  getVersions(callback)

  Internal & External function
  Returns an object with the current applied version of the schema from
  the database and the max version of migration available.
================================================================= */
var getVersions = function (callback) {
  var versions = {}
  getMigrations()
  versions.max = Math.max.apply(null, migrations.map(function (migration) { return migration.version }))
  getCurrentVersion(function (err, version) {
    if (err) {
      if (config.logProgress) {
        console.log('Error in postgrator{isLatestVersion}')
        console.log('Error:' + err)
      }
    } else {
      versions.current = version
    }
    callback(err, versions)
  })
}
exports.getVersions = getVersions

/*
  runMigrations(migrations, finishedCallback)

  Internal function
  Runs the migrations in the order provided, using a recursive kind of approach
  For each migration run:
  - the contents of the script is read (sync because I'm lazy)
  - script is run.
    if error, the callback is called and we don't run anything else
    if success, we then add/remove a record from the config.schemaTable to keep track of the migration we just ran
  - if all goes as planned, we run the next migration
  - once all migrations have been run, we call the callback.
================================================================= */
var runMigrations = function (migrations, finishedCallback) {
  var runNext = function (i) {
    var sql = fs.readFileSync((config.migrationDirectory + '/' + migrations[i].filename), 'utf8')
    if (migrations[i].md5Sql) {
      config.logProgress && console.log('verifying checksum of migration ' + migrations[i].filename)
      runQuery(migrations[i].md5Sql, function (err, result) {
        if (err) {
          config.logProgress && console.log('Error in runMigrations() while retrieving existing migrations')
          if (finishedCallback) {
            finishedCallback(err, migrations)
          }
        } else {
          if (result.rows[0] && result.rows[0].md5 && result.rows[0].md5 !== migrations[i].md5) {
            config.logProgress && console.log('Error in runMigrations() while verifying checksums of existing migrations')

            if (finishedCallback) {
              finishedCallback(new Error('For migration [' + migrations[i].version + '], expected MD5 checksum [' + migrations[i].md5 + '] but got [' + result.rows[0].md5 + ']'), migrations)
            }
          } else {
            i = i + 1
            if (i < migrations.length) {
              runNext(i)
            } else {
              if (finishedCallback) {
                finishedCallback(null, migrations)
              }
            }
          }
        }
      })
    } else {
      config.logProgress && console.log('running ' + migrations[i].filename)
      runQuery(sql, function (err, result) {
        if (err) {
          config.logProgress && console.log('Error in runMigrations()')
          if (finishedCallback) {
            finishedCallback(err, migrations)
          }
        } else {
          // migration ran successfully
          // add version to config.schemaTable table.
          runQuery(migrations[i].schemaVersionSQL, function (err, result) {
            if (err) {
              // SQL to update config.schemaTable failed.
              if (config.logProgress) {
                console.log('error updating the ' + config.schemaTable + ' table')
                console.log(err)
              }
            } else {
              // config.schemaTable successfully recorded.
              // move on to next migration
              i = i + 1
              if (i < migrations.length) {
                runNext(i)
              } else {
                // We are done running the migrations.
                // run the finished callback if supplied.
                if (finishedCallback) {
                  finishedCallback(null, migrations)
                }
              }
            }
          })
        }
      })
    }
  }
  runNext(0)
}

/*
  .getRelevantMigrations(currentVersion, targetVersion)

  returns an array of relevant migrations based on the target and current version passed.
  returned array is sorted in the order it needs to be run
================================================================= */
var getRelevantMigrations = function (currentVersion, targetVersion) {
  var relevantMigrations = []
  if (targetVersion >= currentVersion) {
    // we are migrating up
    // get all up migrations > currentVersion and <= targetVersion
    config.logProgress && console.log('migrating up to ' + targetVersion)
    migrations.forEach(function (migration) {
      if (migration.action === 'do' && migration.version > 0 && migration.version <= currentVersion && (config.driver === 'pg' || config.driver === 'pg.js')) {
        migration.md5Sql = 'SELECT md5 FROM ' + config.schemaTable + ' WHERE version = ' + migration.version + ';'
        relevantMigrations.push(migration)
      }
      if (migration.action === 'do' && migration.version > currentVersion && migration.version <= targetVersion) {
        migration.schemaVersionSQL = config.driver === 'pg' || config.driver === 'pg.js' ? 'INSERT INTO ' + config.schemaTable + ' (version, name, md5) VALUES (' + migration.version + ", '" + migration.name + "', '" + migration.md5 + "');" : 'INSERT INTO ' + config.schemaTable + ' (version) VALUES (' + migration.version + ');'
        relevantMigrations.push(migration)
      }
    })
    relevantMigrations = relevantMigrations.sort(sortMigrationsAsc)
  } else if (targetVersion < currentVersion) {
    // we are going to migrate down
    config.logProgress && console.log('migrating down to ' + targetVersion)
    migrations.forEach(function (migration) {
      if (migration.action === 'undo' && migration.version <= currentVersion && migration.version > targetVersion) {
        migration.schemaVersionSQL = 'DELETE FROM ' + config.schemaTable + ' WHERE version = ' + migration.version + ';'
        relevantMigrations.push(migration)
      }
    })
    relevantMigrations = relevantMigrations.sort(sortMigrationsDesc)
  }
  return relevantMigrations
}

function onlyUnique(value, index, self) {
  return self.indexOf(value) === index;
}

function noZeroes(value, index, self) {
  return value !== 0;
}

function subtractItems(array1, array2) {
  return array1.filter(function (item) {
    return (array2.indexOf(item) === -1)
  })
}

getAllUnrunMigrations = function (callback) {
  getMigrations()
  var relevantMigrations = []
  config.logProgress && console.log('determining all unrun migrations ')
  runQuery(commonClient.queries.getRunVersions, function(err, versions){
    runVersions = versions.rows.map(function(row){
      return parseInt(row.version)
    }).filter(noZeroes)
    potentialMigrations = migrations.map(function (migration) {
      return migration.version
    }).filter(onlyUnique)
    var neededMigrations = subtractItems(potentialMigrations, runVersions)
    relevantMigrations = migrations.filter(function(value){
      return ((neededMigrations.indexOf(value.version) !== -1) && (value.direction === 'do'))
    }).sort(sortMigrationsAsc);
    relevantMigrations = relevantMigrations.map(function(migration){
      migration.schemaVersionSQL = config.driver === 'pg' || config.driver === 'pg.js' ? 'INSERT INTO ' + config.schemaTable + ' (version, name, md5) VALUES (' + migration.version + ", '" + migration.name + "', '" + migration.md5 + "');" : 'INSERT INTO ' + config.schemaTable + ' (version) VALUES (' + migration.version + ');'
      return migration
    })
    callback(err,relevantMigrations);
  })
}

function areMigrationsCurrent(callback){
  getAllUnrunMigrations(function(err,migrations){
    if(err){
      callback(err);
    } else {
      var result = (migrations === []);
      callback(err, result);
    }
  })
}

exports.areMigrationsCurrent = areMigrationsCurrent

/*
  .migrate(target, callback)

  Main method to move a schema to a particular version.
  A target must be specified, otherwise nothing is run.

  target - version to migrate to as string or number (will be handled as numbers internally)
  callback - callback to run after migrations have finished. function (err, migrations) {}
================================================================= */
function migrateToMax(finishedCallback) {
  getAllUnrunMigrations(function(err,relevantMigrations){
    if (relevantMigrations.length > 0) {
      console.log("Running unrun migrations")
      runMigrations(relevantMigrations, function (err, migrations) {
        finishedCallback(err, migrations)
      })
    } else {
      console.log("Already up to date")
      if (finishedCallback) finishedCallback(err)
    }
  });
}

function migrate (target, finishedCallback) {
  prep(function (err) {
    if (err) {
      if (finishedCallback) finishedCallback(err)
    }
    if (target && target === 'max') {
      migrateToMax(finishedCallback);
    } else {
      getMigrations()
      if (target && target === 'max') {
        targetVersion = Math.max.apply(null, migrations.map(function (migration) { return migration.version }))
      } else if (target) {
        targetVersion = Number(target)
      }
      getCurrentVersion(function (err, currentVersion) {
        if (err) {
          config.logProgress && console.log('error getting current version')
          if (finishedCallback) finishedCallback(err)
        } else {
          config.logProgress && console.log('version of database is: ' + currentVersion)
          if (targetVersion === undefined) {
            config.logProgress && console.log('no target version supplied - no migrations performed')
          } else {
            var relevantMigrations = getRelevantMigrations(currentVersion, targetVersion)
            if (relevantMigrations.length > 0) {
              runMigrations(relevantMigrations, function (err, migrations) {
                finishedCallback(err, migrations)
              })
            } else {
              if (finishedCallback) finishedCallback(err)
            }
          }
        }
      })
    }// get current version
  }) // prep
}
exports.migrate = migrate

/*
  .prep(callback)

  Creates the table required for Postgrator to keep track of which migrations have been run.

  callback - function called after schema version table is built. function (err, results) {}
================================================================= */
function prep (callback) {
  runQuery(commonClient.queries.checkTable, function (err, result) {
    if (err) {
      err.helpfulDescription = 'Prep() table CHECK query Failed'
      callback(err)
    } else {
      if (result.rows && result.rows.length > 0) {
        if (config.driver === 'pg' || config.driver === 'pg.js') {
          // config.schemaTable exists, does it have the md5 column? (PostgreSQL only)
          runQuery("SELECT column_name, data_type, character_maximum_length FROM INFORMATION_SCHEMA.COLUMNS WHERE table_name = '" + config.schemaTable + "' AND column_name = 'md5';", function (err, result) {
            if (err) {
              err.helpfulDescription = 'Prep() table CHECK MD5 COLUMN query Failed'
              callback(err)
            } else {
              if (!result.rows || result.rows.length === 0) {
                // md5 column doesn't exist, add it
                runQuery('ALTER TABLE ' + config.schemaTable + " ADD COLUMN md5 text DEFAULT '';", function (err, result) {
                  if (err) {
                    err.helpfulDescription = 'Prep() table ADD MD5 COLUMN query Failed'
                    callback(err)
                  } else {
                    callback()
                  }
                })
              } else {
                callback()
              }
            }
          })
        } else {
          callback()
        }
      } else {
        config.logProgress && console.log('table ' + config.schemaTable + ' does not exist - creating it.')
        runQuery(commonClient.queries.makeTable, function (err, result) {
          if (err) {
            err.helpfulDescription = 'Prep() table BUILD query Failed'
            callback(err)
          } else {
            callback()
          }
        })
      }
    }
  })
}

/*
  .fileChecksum(filename)

  Calculate checksum of file to detect changes to migrations that have already run.

  filename - calculate MD5 checksum of contents of this file
================================================================= */

function fileChecksum (filename, newline) {
  return checksum(fs.readFileSync(filename, 'utf8'), newline)
}

function checksum (str, nl) {
  if (nl) {
    var newline = require('newline')
    config.logProgress && console.log('Converting newline from: ', newline.detect(str), 'to:', nl)
    str = newline.set(str, nl)
  }
  return crypto.createHash('md5').update(str, 'utf8').digest('hex')
}
