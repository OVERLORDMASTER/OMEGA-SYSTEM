const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

const ROOT_DIR = __dirname;
const LOADS_DIR = path.join(ROOT_DIR, 'loadspro');

if (!fs.existsSync(LOADS_DIR)) {
    try {
        fs.mkdirSync(LOADS_DIR, { recursive: true });
    } catch (e) {
        console.error('Error creando carpeta loadspro:', e.message);
    }
}

// Multer para subir imágenes sin restricciones de tamaño pequeñas (hasta 50MB)
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, LOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = (path.extname(file.originalname) || '.png').toLowerCase();
        cb(null, 'omega-' + uniqueSuffix + ext);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
    fileFilter: (req, file, cb) => {
        // Aceptar cualquier formato de imagen sin restricción
        if (
            (file.mimetype && file.mimetype.startsWith('image/')) ||
            /\.(jpg|jpeg|png|gif|webp|svg|ico|jfif|avif|bmp|tiff)$/i.test(file.originalname)
        ) {
            return cb(null, true);
        }
        cb(new Error('Formato no permitido. Solo se permiten imágenes (JPG, PNG, WEBP, GIF, SVG, etc.)'));
    }
});

const uploadMiddleware = (req, res, next) => {
    upload.single('imagen')(req, res, (err) => {
        if (err) {
            console.error('Error de subida Multer:', err.message);
            return res.status(400).json({ error: err.message });
        }
        next();
    });
};

// ═══════════════════════════════════════════════
// MIDDLEWARES
// ═══════════════════════════════════════════════
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir archivos estáticos con caché optimizada para velocidad instantánea
app.use(express.static(ROOT_DIR, {
    maxAge: '1d',
    etag: true
}));

app.use('/loadspro', express.static(LOADS_DIR, {
    maxAge: '30d',
    etag: true,
    immutable: true
}));

app.use('/imagen', express.static(path.join(ROOT_DIR, 'imagen'), {
    maxAge: '30d',
    etag: true
}));

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

// 1. Tabla Usuarios
db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
    )
`);

// 2. Tabla Sitios Web Realizados (Works)
db.exec(`
    CREATE TABLE IF NOT EXISTS works (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        url TEXT NOT NULL,
        descripcion TEXT,
        imagen TEXT
    )
`);

try {
    const tableInfoWorks = db.prepare("PRAGMA table_info(works)").all();
    if (!tableInfoWorks.some(col => col.name === 'descripcion')) {
        db.exec('ALTER TABLE works ADD COLUMN descripcion TEXT');
    }
    if (!tableInfoWorks.some(col => col.name === 'imagen')) {
        db.exec('ALTER TABLE works ADD COLUMN imagen TEXT');
    }
} catch (e) {
    console.error('Info/Error migración tabla works:', e.message);
}

// 3. Tabla Variedades de Software
db.exec(`
    CREATE TABLE IF NOT EXISTS softwares (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        descripcion TEXT,
        imagen TEXT,
        youtube_url TEXT,
        demo_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
`);

// 4. Tabla Categorías (Precios / Catálogo)
db.exec(`
    CREATE TABLE IF NOT EXISTS categorias (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL UNIQUE,
        orden INTEGER DEFAULT 0
    )
`);

// 5. Tabla Productos / Servicios (Precios)
db.exec(`
    CREATE TABLE IF NOT EXISTS productos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        precio_usd REAL NOT NULL,
        caracteristica TEXT NOT NULL,
        imagen TEXT,
        categoria_id INTEGER,
        tipo_entrega TEXT DEFAULT 'ambos',
        FOREIGN KEY (categoria_id) REFERENCES categorias(id) ON DELETE SET NULL
    )
`);

// 6. Tabla Configuración
db.exec(`
    CREATE TABLE IF NOT EXISTS configuracion (
        key TEXT PRIMARY KEY,
        value TEXT
    )
`);

// Crear usuario admin por primera vez
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
app.post('/api/login', noCache, (req, res) => {
    const username = (req.body && req.body.username) ? String(req.body.username).trim() : '';
    const password = (req.body && req.body.password) ? String(req.body.password) : '';
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Usuario y contraseña requeridos' });
    }

    const user = db.prepare('SELECT * FROM usuarios WHERE LOWER(username) = LOWER(?)').get(username);
    if (!user) {
        return res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
    }

    bcrypt.compare(password, user.password_hash, (err, result) => {
        if (result) {
            res.json({ success: true, username: user.username });
        } else {
            res.status(401).json({ success: false, message: 'Credenciales incorrectas' });
        }
    });
});

app.post('/api/user/change-password', noCache, (req, res) => {
    const username = (req.body && req.body.username) ? String(req.body.username).trim() : '';
    const oldPassword = (req.body && req.body.oldPassword) ? String(req.body.oldPassword) : '';
    const newPassword = (req.body && req.body.newPassword) ? String(req.body.newPassword) : '';
    if (!username || !oldPassword || !newPassword) {
        return res.status(400).json({ success: false, message: 'Todos los campos son requeridos' });
    }

    const user = db.prepare('SELECT * FROM usuarios WHERE LOWER(username) = LOWER(?)').get(username);
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
// API REST - WORKS (Sitios Web Realizados)
// ═══════════════════════════════════════════════
app.get('/api/works', noCache, (req, res) => {
    try {
        const works = db.prepare('SELECT * FROM works ORDER BY id DESC').all();
        res.json(works);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener los trabajos' });
    }
});

app.post('/api/works', uploadMiddleware, noCache, (req, res) => {
    const nombre = (req.body.nombre || '').trim();
    const url = (req.body.url || '').trim();
    const descripcion = (req.body.descripcion || '').trim();

    if (!nombre) {
        return res.status(400).json({ error: 'El nombre del sitio web es obligatorio' });
    }
    const finalUrl = url || '#';
    const imagen = req.file ? `/loadspro/${req.file.filename}` : (req.body.imagen || null);

    try {
        const result = db.prepare('INSERT INTO works (nombre, url, descripcion, imagen) VALUES (?, ?, ?, ?)').run(nombre, finalUrl, descripcion, imagen);
        res.status(201).json({ id: result.lastInsertRowid, nombre, url: finalUrl, descripcion, imagen });
    } catch (error) {
        console.error('Error al insertar sitio web en DB:', error);
        res.status(500).json({ error: 'Error en base de datos al crear el sitio web: ' + error.message });
    }
});

app.put('/api/works/:id', uploadMiddleware, noCache, (req, res) => {
    const { id } = req.params;
    try {
        const existing = db.prepare('SELECT * FROM works WHERE id = ?').get(id);
        if (!existing) {
            return res.status(404).json({ error: 'Sitio web no encontrado' });
        }

        const nombre = (req.body.nombre && req.body.nombre.trim()) ? req.body.nombre.trim() : existing.nombre;
        const url = (req.body.url && req.body.url.trim()) ? req.body.url.trim() : existing.url;
        const descripcion = req.body.descripcion !== undefined ? req.body.descripcion.trim() : (existing.descripcion || '');

        let imagen = existing.imagen;
        if (req.file) {
            imagen = `/loadspro/${req.file.filename}`;
        } else if (req.body.imagen !== undefined && req.body.imagen !== '') {
            imagen = req.body.imagen;
        }

        db.prepare('UPDATE works SET nombre = ?, url = ?, descripcion = ?, imagen = ? WHERE id = ?').run(nombre, url, descripcion, imagen, id);
        res.json({ message: 'Sitio web actualizado con éxito', id, nombre, url, descripcion, imagen });
    } catch (error) {
        console.error('Error al actualizar sitio web en DB:', error);
        res.status(500).json({ error: 'Error en base de datos al actualizar: ' + error.message });
    }
});

app.delete('/api/works/:id', noCache, (req, res) => {
    const { id } = req.params;
    const result = db.prepare('DELETE FROM works WHERE id = ?').run(id);
    res.json({ message: 'Trabajo eliminado' });
});

// ═══════════════════════════════════════════════
// API REST - SOFTWARES (Variedades de Software)
// ═══════════════════════════════════════════════
app.get('/api/softwares', noCache, (req, res) => {
    try {
        const softwares = db.prepare('SELECT * FROM softwares ORDER BY id DESC').all();
        res.json(softwares);
    } catch (error) {
        res.status(500).json({ error: 'Error al obtener los softwares' });
    }
});

app.post('/api/softwares', uploadMiddleware, noCache, (req, res) => {
    try {
        const nombre = (req.body.nombre || '').trim();
        const descripcion = (req.body.descripcion || '').trim();
        const youtube_url = (req.body.youtube_url || '').trim();
        const demo_url = (req.body.demo_url || '').trim();

        if (!nombre) {
            return res.status(400).json({ error: 'El nombre del software es requerido' });
        }
        const imagen = req.file ? `/loadspro/${req.file.filename}` : (req.body.imagen || null);
        const result = db.prepare(`
            INSERT INTO softwares (nombre, descripcion, imagen, youtube_url, demo_url)
            VALUES (?, ?, ?, ?, ?)
        `).run(nombre, descripcion, imagen, youtube_url, demo_url);

        res.status(201).json({
            id: result.lastInsertRowid,
            nombre,
            descripcion,
            imagen,
            youtube_url,
            demo_url
        });
    } catch (error) {
        console.error('Error al guardar software:', error);
        res.status(500).json({ error: 'Error al crear el software' });
    }
});

app.put('/api/softwares/:id', uploadMiddleware, noCache, (req, res) => {
    try {
        const { id } = req.params;
        const existing = db.prepare('SELECT * FROM softwares WHERE id = ?').get(id);
        if (!existing) {
            return res.status(404).json({ error: 'Software no encontrado' });
        }

        const nombre = (req.body.nombre && req.body.nombre.trim()) ? req.body.nombre.trim() : existing.nombre;
        const descripcion = req.body.descripcion !== undefined ? req.body.descripcion.trim() : (existing.descripcion || '');
        const youtube_url = req.body.youtube_url !== undefined ? req.body.youtube_url.trim() : (existing.youtube_url || '');
        const demo_url = req.body.demo_url !== undefined ? req.body.demo_url.trim() : (existing.demo_url || '');

        let imagen = existing.imagen;
        if (req.file) {
            imagen = `/loadspro/${req.file.filename}`;
        } else if (req.body.imagen !== undefined && req.body.imagen !== '') {
            imagen = req.body.imagen;
        }

        db.prepare(`
            UPDATE softwares 
            SET nombre = ?, descripcion = ?, imagen = ?, youtube_url = ?, demo_url = ?
            WHERE id = ?
        `).run(nombre, descripcion, imagen, youtube_url, demo_url, id);

        res.json({ message: 'Software actualizado con éxito', id, nombre, descripcion, imagen, youtube_url, demo_url });
    } catch (error) {
        console.error('Error al actualizar software en DB:', error);
        res.status(500).json({ error: 'Error en base de datos al actualizar: ' + error.message });
    }
});

app.delete('/api/softwares/:id', noCache, (req, res) => {
    try {
        const { id } = req.params;
        const software = db.prepare('SELECT * FROM softwares WHERE id = ?').get(id);
        if (software && software.imagen && software.imagen.startsWith('/loadspro/')) {
            const filePath = path.join(ROOT_DIR, software.imagen);
            if (fs.existsSync(filePath)) {
                try { fs.unlinkSync(filePath); } catch (e) { }
            }
        }
        db.prepare('DELETE FROM softwares WHERE id = ?').run(id);
        res.json({ message: 'Software eliminado' });
    } catch (error) {
        res.status(500).json({ error: 'Error al eliminar el software' });
    }
});

// ═══════════════════════════════════════════════
// API REST - PRODUCTOS & CATEGORÍAS (PRECIOS)
// ═══════════════════════════════════════════════
function obtenerOCrearCategoria(nombre) {
    if (!nombre || nombre.trim() === '') return null;
    const nombreLimpio = nombre.trim();
    let cat = db.prepare('SELECT id, orden FROM categorias WHERE nombre = ?').get(nombreLimpio);
    if (cat) return cat.id;
    const maxOrden = db.prepare('SELECT MAX(orden) AS max FROM categorias').get().max || 0;
    const nuevoOrden = maxOrden + 1;
    const result = db.prepare('INSERT INTO categorias (nombre, orden) VALUES (?, ?)').run(nombreLimpio, nuevoOrden);
    return result.lastInsertRowid;
}

app.get('/api/productos', noCache, (req, res) => {
    const productos = db.prepare(`
        SELECT p.*, c.nombre AS categoria_nombre, c.orden AS categoria_orden
        FROM productos p
        LEFT JOIN categorias c ON p.categoria_id = c.id
        ORDER BY c.orden ASC NULLS LAST, p.nombre ASC
    `).all();
    res.json(productos.map(p => ({
        ...p,
        imagen: p.imagen ? (p.imagen.startsWith('/') ? p.imagen : `/loadspro/${p.imagen}`) : null
    })));
});

app.post('/api/productos', noCache, uploadMiddleware, (req, res) => {
    const { nombre, precio_usd, caracteristica, categoria, tipo_entrega } = req.body;
    if (!nombre || !precio_usd || !caracteristica) {
        return res.status(400).json({ error: 'Todos los campos son obligatorios' });
    }
    const imagen = req.file ? req.file.filename : null;
    const catId = obtenerOCrearCategoria(categoria);
    const entrega = tipo_entrega || 'ambos';

    const stmt = db.prepare(`
        INSERT INTO productos (nombre, precio_usd, caracteristica, imagen, categoria_id, tipo_entrega)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(nombre, precio_usd, caracteristica, imagen, catId, entrega);
    res.status(201).json({
        id: result.lastInsertRowid,
        nombre,
        precio_usd,
        caracteristica,
        imagen,
        categoria_id: catId,
        tipo_entrega: entrega
    });
});

app.put('/api/productos/:id', noCache, uploadMiddleware, (req, res) => {
    const { id } = req.params;
    const { nombre, precio_usd, caracteristica, categoria, tipo_entrega } = req.body;
    const nuevaImagen = req.file ? req.file.filename : undefined;
    const catId = obtenerOCrearCategoria(categoria);
    const entrega = tipo_entrega || 'ambos';

    if (nuevaImagen) {
        db.prepare(`
            UPDATE productos
            SET nombre=?, precio_usd=?, caracteristica=?, imagen=?, categoria_id=?, tipo_entrega=?
            WHERE id=?
        `).run(nombre, precio_usd, caracteristica, nuevaImagen, catId, entrega, id);
    } else {
        db.prepare(`
            UPDATE productos
            SET nombre=?, precio_usd=?, caracteristica=?, categoria_id=?, tipo_entrega=?
            WHERE id=?
        `).run(nombre, precio_usd, caracteristica, catId, entrega, id);
    }
    res.json({ mensaje: 'Producto actualizado' });
});

app.delete('/api/productos/:id', noCache, (req, res) => {
    db.prepare('DELETE FROM productos WHERE id=?').run(req.params.id);
    res.json({ mensaje: 'Producto eliminado' });
});

app.get('/api/categorias', noCache, (req, res) => {
    const categorias = db.prepare('SELECT * FROM categorias ORDER BY orden ASC, nombre ASC').all();
    res.json(categorias);
});

app.delete('/api/categorias/:id', noCache, (req, res) => {
    const { id } = req.params;
    db.prepare('UPDATE productos SET categoria_id = NULL WHERE categoria_id = ?').run(id);
    db.prepare('DELETE FROM categorias WHERE id = ?').run(id);
    res.json({ mensaje: 'Categoría eliminada' });
});

app.get('/api/configuracion/:key', noCache, (req, res) => {
    const { key } = req.params;
    const row = db.prepare('SELECT value FROM configuracion WHERE key = ?').get(key);
    if (row) {
        res.json({ key, value: row.value });
    } else {
        if (key === 'estado_negocio') {
            res.json({ key, value: 'normal' });
        } else {
            res.status(404).json({ error: 'Clave de configuración no encontrada' });
        }
    }
});

app.put('/api/configuracion/:key', noCache, (req, res) => {
    const { key } = req.params;
    const { value } = req.body;
    if (value === undefined) {
        return res.status(400).json({ error: 'El valor es requerido' });
    }
    db.prepare('INSERT INTO configuracion (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    res.json({ success: true, message: `Configuración '${key}' actualizada` });
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
    console.log(`📁 Directorio raíz: ${ROOT_DIR}`);
    console.log(`🖼️ Carpeta loadspro: ${LOADS_DIR}`);
});