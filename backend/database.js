'use strict';

const mysql = require('mysql2/promise');

let pool;

function isDatabaseConfigured() {
  return Boolean(process.env.DB_HOST && process.env.DB_NAME
    && process.env.DB_USER && process.env.DB_PASSWORD !== undefined);
}

function getPool() {
  if (!isDatabaseConfigured()) {
    const error = new Error('Database configuration is missing. Copy .env.example to .env and set DB_HOST, DB_NAME, DB_USER, and DB_PASSWORD.');
    error.code = 'DATABASE_NOT_CONFIGURED';
    throw error;
  }
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      charset: 'utf8mb4',
      decimalNumbers: false,
    });
  }
  return pool;
}

async function query(sql, values = []) {
  const [rows] = await getPool().execute(sql, values);
  return rows;
}

async function transaction(work) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

async function closePool() {
  if (pool) {
    const current = pool;
    pool = undefined;
    await current.end();
  }
}

module.exports = { closePool, getPool, isDatabaseConfigured, query, transaction };
