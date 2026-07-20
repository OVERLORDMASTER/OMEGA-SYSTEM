const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT_DIR = __dirname;

// ═══════════════════════════════════════════════
// MIDDLEWARE
// ═══════════════════════════════════════════════
app.use(cors());
app.use(express.json());
app.use(express.static(ROOT_DIR));

// Middleware para evitar caché en las respuestas de la API
const noCache = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
};

// ═══════════════════════════════════════════════
// BASE DE DATOS
// ═══════════════════════════════════════════════
const db = new Database(path.join(ROOT_DIR, 'productos.db'));
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS works (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        url TEXT NOT NULL
    )
`);

// ─── Crear usuario admin inicial si no existe ───
const userCount = db.prepare('SELECT COUNT(id) as count FROM usuarios').get().count;
if (userCount === 0) {
    const defaultUser = 'admin';
    const tempPassword = crypto.randomBytes(8).toString('hex');
    const saltRounds = 10;
    bcrypt.hash(tempPassword, saltRounds, (err, hash) => {
        if (err) {
            console.error('❌ Error al hashear la contraseña inicial:', err);
        } else {
            db.prepare('INSERT INTO usuarios (username, password_hash) VALUES (?, ?)').run(defaultUser, hash);
            console.log('============================================================');
            console.log('      CREDENCIALES DE ADMINISTRADOR POR PRIMERA VEZ      ');
            console.log(`      Usuario: ${defaultUser}`);
            console.log(`      Contraseña: ${tempPassword}`);
            console.log('      Guardá esta contraseña y cambiala lo antes posible.');
            console.log('============================================================');
        }
    });
}

// ═══════════════════════════════════════════════
// API REST - AUTENTICACIÓN
// ═══════════════════════════════════════════════

// Login
app.post('/api/login', noCache, (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Usuario y contraseña requeridos' });
    }

    const user = db.prepare('SELECT * FROM usuarios WHERE username = ?').get(username);
    if (!user) {
        return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
    }

    bcrypt.compare(password, user.password_hash, (err, result) => {
        if (result) {
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
        }
    });
});

// Cambiar contraseña
app.post('/api/user/change-password', noCache, (req, res) => {
    const { username, oldPassword, newPassword } = req.body;
    if (!username || !oldPassword || !newPassword) {
        return res.status(400).json({ success: false, message: 'Todos los campos son requeridos' });
    }

    const user = db.prepare('SELECT * FROM usuarios WHERE username = ?').get(username);
    if (!user) {
        return res.status(404).json({ success: false, message: 'Usuario no encontrado' });
    }

    bcrypt.compare(oldPassword, user.password_hash, (err, result) => {
        if (result) {
            const saltRounds = 10;
            bcrypt.hash(newPassword, saltRounds, (err, hash) => {
                db.prepare('UPDATE usuarios SET password_hash = ? WHERE id = ?').run(hash, user.id);
                res.json({ success: true, message: 'Contraseña actualizada correctamente' });
            });
        } else {
            res.status(401).json({ success: false, message: 'La contraseña actual es incorrecta' });
        }
    });
});

// ═══════════════════════════════════════════════
// API REST - WORKS
// ═══════════════════════════════════════════════

// Get all works
app.get('/api/works', noCache, (req, res) => {
    try {
        const works = db.prepare('SELECT * FROM works ORDER BY id DESC').all();
        res.json(works);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener los trabajos' });
    }
});

// Create a work
app.post('/api/works', noCache, (req, res) => {
    const { nombre, url } = req.body;
    if (!nombre || !url) {
        return res.status(400).json({ error: 'Nombre y URL son requeridos' });
    }
    try {
        const result = db.prepare('INSERT INTO works (nombre, url) VALUES (?, ?)').run(nombre, url);
        res.status(201).json({ id: result.lastInsertRowid, nombre, url });
    } catch (error) {
        res.status(500).json({ error: 'Error al crear el trabajo' });
    }
});

// Update a work
app.put('/api/works/:id', noCache, (req, res) => {
    const { id } = req.params;
    const { nombre, url } = req.body;
    if (!nombre || !url) {
        return res.status(400).json({ error: 'Nombre y URL son requeridos' });
    }
    try {
        const result = db.prepare('UPDATE works SET nombre = ?, url = ? WHERE id = ?').run(nombre, url, id);
        if (result.changes === 0) {
            return res.status(404).json({ error: 'Trabajo no encontrado' });
        }
        res.json({ message: 'Trabajo actualizado' });
    } catch (error) {
        res.status(500).json({ error: 'Error al actualizar el trabajo' });
    }
});

// Delete a work
app.delete('/api/works/:id', noCache, (req, res) => {
    const { id } = req.params;
    const result = db.prepare('DELETE FROM works WHERE id = ?').run(id);
    res.json({ message: 'Trabajo eliminado' });
});

// ═══════════════════════════════════════════════
// MANEJO DE ERRORES GLOBAL
// ═══════════════════════════════════════════════
app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
});

// ═══════════════════════════════════════════════
// INICIO DEL SERVIDOR
// ═══════════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
    console.log(`📁 Archivos estáticos: ${ROOT_DIR}`);
});