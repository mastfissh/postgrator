var assert = require('assert')
var async = require('async')
var path = require('path')
var fs = require('fs')

var tests = []
var pgUrl = 'tcp://postgrator:postgrator@localhost:5432/postgrator'

var migrationDirectory = path.join(__dirname, 'migrations')

/* Test postgres connection string API
============================================================================= */
tests.push(function (callback) {
  console.log('\n----- testing original api to 003 -----')
  var postgrator = require('../postgrator.js')
  postgrator.setConfig({
    driver: 'pg.js',
    migrationDirectory: migrationDirectory,
    connectionString: pgUrl
  })
  postgrator.migrate('003', function (err, migrations) {
    assert.ifError(err)
    postgrator.endConnection(callback)
  })
})

tests.push(function (callback) {
  console.log('\n----- testing original api to 000 -----')
  var postgrator = require('../postgrator.js')
  postgrator.setConfig({
    driver: 'pg.js',
    migrationDirectory: migrationDirectory,
    connectionString: pgUrl
  })
  postgrator.migrate('000', function (err, migrations) {
    assert.ifError(err)
    postgrator.endConnection(callback)
  })
})

/* A function to build a set of tests for a given config.
   This will be helpful when we want to run the same kinds of tests on
   postgres, mysql, sql server, etc.
============================================================================= */
var buildTestsForConfig = function (config) {
  /* Go 2 migrations up.
  ------------------------------------------------------------------------- */
  tests.push(function (callback) {
    console.log('\n----- ' + config.driver + ' up to 002 -----')
    var pg = require('../postgrator.js')
    pg.setConfig(config)
    pg.migrate('002', function (err, migrations) {
      assert.ifError(err)
      pg.runQuery('SELECT name, age FROM person', function (err, result) {
        assert.ifError(err)
        assert.equal(result.rows.length, 1, 'person table should have 1 record at this point')
        pg.endConnection(callback)
      })
    })
  })

  /* try migrating to current version.
  ------------------------------------------------------------------------- */
  tests.push(function (callback) {
    console.log('\n----- ' + config.driver + ' up to 002 -----')
    var pg = require('../postgrator.js')
    pg.setConfig(config)
    pg.migrate('002', function (err, migrations) {
      if (err) throw err
      console.log('migrated to 002, current version')
      callback()
    })
  })

  /* Go 1 migration up.
  ------------------------------------------------------------------------- */
  tests.push(function (callback) {
    console.log('\n----- ' + config.driver + ' up to 003 -----')
    var pg = require('../postgrator.js')
    pg.setConfig(config)
    pg.migrate('003', function (err, migrations) {
      assert.ifError(err)
      pg.runQuery('SELECT name, age FROM person', function (err, result) {
        assert.ifError(err)
        assert.equal(result.rows.length, 3, 'person table should have 3 records at this point')
        pg.endConnection(callback)
      })
    })
  })

  /* Go up to 'max' (5)
  ------------------------------------------------------------------------- */
  tests.push(function (callback) {
    console.log('\n----- ' + config.driver + ' up to max (005) -----')
    var pg = require('../postgrator.js')
    pg.setConfig(config)
    pg.migrate('max', function (err, migrations) {
      assert.ifError(err)
      pg.runQuery('SELECT name, age FROM person', function (err, result) {
        assert.ifError(err)
        assert.equal(result.rows.length, 4, 'person table should have 4 records at this point')
        pg.endConnection(callback)
      })
    })
  })

  tests.push(function (callback) {
    console.log('\n----- ' + config.driver + ' edge case - what if 004 was merged in after 005 run?')
    fs.renameSync('./test/migrations/004.do.notsql', './test/migrations/004.do.sql');
    fs.renameSync('./test/migrations/004.undo.notsql', './test/migrations/004.undo.sql');
    var pg = require('../postgrator.js')
    pg.setConfig(config)
    pg.migrate('max', function (err, migrations) {
      fs.renameSync('./test/migrations/004.do.sql', './test/migrations/004.do.notsql');
      fs.renameSync('./test/migrations/004.undo.sql', './test/migrations/004.undo.notsql');
      assert.ifError(err)
      pg.runQuery('SELECT name, age FROM person', function (err, result) {
        assert.ifError(err)
        assert.equal(result.rows.length, 5, 'person table should have 5 records at this point')
        pg.endConnection(callback)
      })
    })
  })

  /* Go down to 0
  ------------------------------------------------------------------------- */
  tests.push(function (callback) {
    console.log('\n----- ' + config.driver + ' down to 000 -----')
    var pg = require('../postgrator.js')
    pg.setConfig(config)
    setTimeout(function () {
      pg.migrate('00', function (err, migrations) {
        assert.ifError(err)
        pg.endConnection(callback)
      })
    }, 10000)
  })

  /* remove version table for next run (to test table creation)
  ------------------------------------------------------------------------- */
  tests.push(function (callback) {
    console.log('\n----- ' + config.driver + ' removing schemaversion table -----')
    var pg = require('../postgrator.js')
    pg.setConfig(config)
    pg.runQuery('DROP TABLE schemaversion', function (err) {
      assert.ifError(err)
      pg.endConnection(callback)
    })
  })
}

buildTestsForConfig({
  migrationDirectory: migrationDirectory,
  driver: 'pg.js',
  host: 'localhost',
  port: 5432,
  database: 'postgrator',
  username: 'postgrator',
  password: 'postgrator',
  logProgress: false
})

buildTestsForConfig({
  migrationDirectory: migrationDirectory,
  driver: 'mysql',
  host: 'localhost',
  port: 3306,
  database: 'test',
  username: 'root',
  password: 'root'
})

buildTestsForConfig({
  migrationDirectory: migrationDirectory,
  driver: 'tedious',
  host: '127.0.0.1',
  port: 1433,
  database: 'Utility',
  username: 'sa',
  password: 'testuser'
})

/* Run the tests in an asyncy way
============================================================================= */
console.log('Running ' + tests.length + ' tests')
async.eachSeries(tests, function (testFunc, callback) {
  testFunc(callback)
}, function (err) {
  assert.ifError(err) // this won't ever happen, as we don't pass errors on in our test. But just in case we do some day...
  console.log('\nEverythings gonna be alright')
  process.exit(0)
})
