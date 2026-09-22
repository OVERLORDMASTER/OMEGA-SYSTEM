const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'local_data');
const LOADS_DIR = path.join(DATA_DIR, 'loadspro');
const PROJECT_ROOT = path.resolve(__dirname, '..');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(LOADS_DIR)) {
    try {
        fs.mkdirSync(LOADS_DIR, { recursive: true });
        console.log('✅ Carpeta de subidas creada en:', LOADS_DIR);
    } catch (error) {
        console.error('❌ No se pudo crear la carpeta de subidas:', error.message);
        process.exit(1);
    }
}

try {
    fs.accessSync(LOADS_DIR, fs.constants.W_OK);
    console.log('✅ Permisos de escritura en el directorio de datos correctos');
} catch (error) {
    console.error('❌ No se tienen permisos de escritura en', DATA_DIR);
    console.error('Ejecutá el servidor con permisos adecuados o cambiá los permisos de la carpeta.');
    process.exit(1);
}

app.use(cors());
app.use(express.json());
app.use(express.static(PROJECT_ROOT));
app.use('/loadspro', express.static(LOADS_DIR));

const noCache = (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
};
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, LOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname);
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const tipos = /jpeg|jpg|png|gif|webp/;
        const ext = tipos.test(path.extname(file.originalname).toLowerCase());
        const mime = tipos.test(file.mimetype);
        if (ext && mime) {
            cb(null, true);
        } else {
            cb(new Error('Formato no permitido. Solo: jpg, png, gif, webp'));
        }
    }
});

const uploadMiddleware = (req, res, next) => {
    upload.single('imagen')(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message });
        }
        next();
    });
};

const db = new Database(path.join(DATA_DIR, 'productos.db'));
db.pragma('journal_mode = WAL');

db.exec(`
    CREATE TABLE IF NOT EXISTS categorias (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL UNIQUE,
        orden INTEGER DEFAULT 0
    )
`);

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

db.exec(`
    CREATE TABLE IF NOT EXISTS configuracion (
        key TEXT PRIMARY KEY,
        value TEXT
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS usuarios (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
    )
`);

const tableInfoCats = db.prepare("PRAGMA table_info(categorias)").all();
if (!tableInfoCats.some(col => col.name === 'orden')) {
    db.exec('ALTER TABLE categorias ADD COLUMN orden INTEGER DEFAULT 0');
    console.log('✅ Columna "orden" agregada a categorias');
}

const tableInfoProds = db.prepare("PRAGMA table_info(productos)").all();
if (!tableInfoProds.some(col => col.name === 'tipo_entrega')) {
    db.exec('ALTER TABLE productos ADD COLUMN tipo_entrega TEXT DEFAULT "ambos"');
    console.log('✅ Columna "tipo_entrega" agregada a productos');
}

const categoriasSinOrden = db.prepare('SELECT id FROM categorias WHERE orden = 0').all();
if (categoriasSinOrden.length > 0) {
    const todas = db.prepare('SELECT id FROM categorias ORDER BY nombre').all();
    todas.forEach((cat, idx) => {
        db.prepare('UPDATE categorias SET orden = ? WHERE id = ?').run(idx + 1, cat.id);
    });
    console.log('✅ Órdenes iniciales asignadas a categorías');
}
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
        imagen: p.imagen ? `/loadspro/${p.imagen}` : null
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
    res.json({ success: true, message: `Configuración '${key}' actualizada a '${value}'` });
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

app.put('/api/categorias/:id/mover', noCache, (req, res) => {
    const { id } = req.params;
    const { direccion } = req.body;

    if (!['up', 'down'].includes(direccion)) {
        return res.status(400).json({ error: 'Dirección inválida. Use "up" o "down"' });
    }

    const catActual = db.prepare('SELECT id, orden FROM categorias WHERE id = ?').get(id);
    if (!catActual) {
        return res.status(404).json({ error: 'Categoría no encontrada' });
    }

    const ordenActual = catActual.orden;

    let vecino;
    if (direccion === 'up') {
        vecino = db.prepare('SELECT id, orden FROM categorias WHERE orden < ? ORDER BY orden DESC LIMIT 1').get(ordenActual);
    } else {
        vecino = db.prepare('SELECT id, orden FROM categorias WHERE orden > ? ORDER BY orden ASC LIMIT 1').get(ordenActual);
    }

    if (!vecino) {
        return res.status(400).json({ error: 'No hay categoría para intercambiar en esa dirección' });
    }

    const update1 = db.prepare('UPDATE categorias SET orden = ? WHERE id = ?');
    const update2 = db.prepare('UPDATE categorias SET orden = ? WHERE id = ?');

    const trans = db.transaction(() => {
        update1.run(vecino.orden, catActual.id);
        update2.run(ordenActual, vecino.id);
    });
    trans();

    res.json({ mensaje: 'Orden actualizado correctamente' });
});

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

app.use((err, req, res, next) => {
    console.error('Error:', err);
    res.status(500).json({ error: err.message || 'Error interno del servidor' });
});

app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
    console.log(`📁 Sirviendo archivos estáticos desde: ${PROJECT_ROOT}`);
    console.log(`💾 Directorio de datos (DB, imágenes): ${DATA_DIR}`);
});