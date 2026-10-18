const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const slugify = require('slugify');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const expressLayouts = require('express-ejs-layouts');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();

// 1. Neon Cloud Database Connection
const pool = new Pool({
  connectionString: 'postgresql://neondb_owner:npg_V81REgDvqnHI@ep-lingering-pine-aorj9mrk-pooler.c-2.ap-southeast-1.aws.neon.tech/neondb?sslmode=require',
  ssl: {
    rejectUnauthorized: false
  }
});

// 2. Gmail SMTP Setup for Password Reset
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: 'panduchalla2022@gmail.com',
    pass: 'ivml qnue pkja qgfv'
  }
});

const resetTokens = {}; // Password reset tokens memory

// 3. Ensure uploads folder exists
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'public/uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, 'img-' + Date.now() + '-' + Math.round(Math.random() * 1E9) + ext);
  }
});
const upload = multer({ storage: storage });

// 4. Initialize Database Tables
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(255) UNIQUE NOT NULL,
        phone_email VARCHAR(255) UNIQUE NOT NULL,
        password TEXT NOT NULL,
        upi_id VARCHAR(255),
        bank_details TEXT,
        is_admin INT DEFAULT 0
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS stories (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        slug VARCHAR(255) UNIQUE NOT NULL,
        content TEXT NOT NULL,
        category VARCHAR(100),
        image_url TEXT,
        views INT DEFAULT 0,
        likes INT DEFAULT 0,
        author_id INT REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS comments (
        id SERIAL PRIMARY KEY,
        story_id INT REFERENCES stories(id) ON DELETE CASCADE,
        author_name VARCHAR(255) NOT NULL,
        comment TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        story_id INT REFERENCES stories(id) ON DELETE CASCADE,
        sender_id INT REFERENCES users(id) ON DELETE CASCADE,
        receiver_id INT REFERENCES users(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('✅ Neon PostgreSQL Database tables initialized successfully.');
  } catch (err) {
    console.error('❌ Database Initialization Error:', err.message);
  }
};
initDB();

// 5. Middleware & Layout Configuration
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));

app.use(expressLayouts);
app.set('layout', 'layout');
app.set('view engine', 'ejs');

app.use(
  session({
    secret: 'my-telugu-story-secret-key',
    resave: false,
    saveUninitialized: false,
  })
);

app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.searchQuery = req.query.search || '';
  next();
});

const requireLogin = (req, res, next) => {
  if (!req.session.user) return res.redirect('/login');
  next();
};

const defaultCategories = [
  'నీతి కథలు',
  'పిట్ట కథలు',
  'హాస్య కథలు',
  'కవితలు',
  'జీవిత సత్యాలు',
  'ప్రేమకథలు',
  'భయానక కథలు',
  'సాధారణ కథలు'
];

// 6. Homepage Route
app.get('/', async (req, res) => {
  try {
    const selectedCategory = req.query.category || null;
    const searchQuery = req.query.search ? req.query.search.trim() : null;

    let queryText = `
      SELECT stories.*, users.username AS author_name 
      FROM stories 
      LEFT JOIN users ON stories.author_id = users.id
      WHERE 1=1
    `;
    const params = [];

    if (selectedCategory) {
      params.push(selectedCategory);
      queryText += ` AND stories.category = $${params.length}`;
    }

    if (searchQuery) {
      params.push(`%${searchQuery}%`);
      const pIdx = params.length;
      queryText += ` AND (stories.title ILIKE $${pIdx} OR stories.content ILIKE $${pIdx} OR users.username ILIKE $${pIdx})`;
    }

    queryText += ' ORDER BY stories.created_at DESC';

    const storiesRes = await pool.query(queryText, params);
    const popularRes = await pool.query('SELECT title, slug, views, likes, category FROM stories ORDER BY views DESC LIMIT 5');
    const catRes = await pool.query('SELECT category, COUNT(*) as count FROM stories GROUP BY category');

    const countsMap = {};
    catRes.rows.forEach(r => { countsMap[r.category] = parseInt(r.count, 10); });

    const categoryList = defaultCategories.map(cat => ({
      name: cat,
      count: countsMap[cat] || 0
    }));

    res.render('index', {
      stories: storiesRes.rows || [],
      categories: categoryList,
      popularStories: popularRes.rows || [],
      selectedCategory,
      searchQuery,
      title: searchQuery ? `శోధన: ${searchQuery}` : (selectedCategory ? selectedCategory : 'తెలుగు కథలు')
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Database error');
  }
});

// 7. Policy Pages
app.get('/about', (req, res) => res.render('about', { title: 'మా గురించి - About Us' }));
app.get('/privacy', (req, res) => res.render('privacy', { title: 'గోప్యతా విధానం - Privacy Policy' }));
app.get('/contact', (req, res) => res.render('contact', { title: 'మమ్మల్ని సంప్రదించండి - Contact Us' }));

// 8. Auth: Direct Register (No OTP needed)
app.get('/register', (req, res) => res.render('register', { error: null, title: 'ఖాతా తెరవండి' }));
app.post('/register', async (req, res) => {
  const { username, phone_email, password, upi_id, bank_details } = req.body;
  const target = (phone_email || '').trim().toLowerCase();

  try {
    const hash = await bcrypt.hash(password, 10);
    const countRes = await pool.query('SELECT COUNT(*) as count FROM users');
    const isFirst = parseInt(countRes.rows[0].count, 10) === 0;
    const isOwner = target === '9490872592' || target === 'panduchalla2022@gmail.com';
    const isAdmin = (isFirst || isOwner) ? 1 : 0;

    await pool.query(
      'INSERT INTO users (username, phone_email, password, upi_id, bank_details, is_admin) VALUES ($1, $2, $3, $4, $5, $6)',
      [username.trim(), target, hash, upi_id || null, bank_details || null, isAdmin]
    );

    res.redirect('/login');
  } catch (err) {
    console.error(err);
    res.render('register', { error: 'ఈ యూజర్‌నేమ్ లేదా ఈమెయిల్/నంబర్ ఇప్పటికే వాడుకలో ఉంది.', title: 'ఖాతా తెరవండి' });
  }
});

// 9. Auth: Login
app.get('/login', (req, res) => res.render('login', { error: null, title: 'లాగిన్' }));
app.post('/login', async (req, res) => {
  const { identifier, password } = req.body;
  const target = (identifier || '').trim().toLowerCase();

  try {
    const result = await pool.query('SELECT * FROM users WHERE LOWER(username) = $1 OR LOWER(phone_email) = $1', [target]);
    const user = result.rows[0];

    if (user && await bcrypt.compare(password, user.password)) {
      const isOwner = user.phone_email === '9490872592' || user.phone_email === 'panduchalla2022@gmail.com';
      const isAdmin = (user.is_admin === 1 || isOwner) ? 1 : 0;
      req.session.user = { id: user.id, username: user.username, is_admin: isAdmin };
      return res.redirect('/');
    }
    res.render('login', { error: 'వివరాలు సరైనవి కావు. మళ్ళీ ప్రయత్నించండి.', title: 'లాగిన్' });
  } catch (err) {
    res.render('login', { error: 'లాగిన్ లోపం ఏర్పడింది.', title: 'లాగిన్' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/');
});

// 10. Forgot Password via Gmail Link
app.get('/forgot-password', (req, res) => {
  res.render('forgot_password', { message: null, error: null, title: 'పాస్‌వర్డ్ మర్చిపోయారా?' });
});

app.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  const target = (email || '').trim().toLowerCase();

  try {
    const userRes = await pool.query('SELECT * FROM users WHERE LOWER(phone_email) = $1', [target]);
    if (userRes.rows.length === 0) {
      return res.render('forgot_password', { error: 'ఈ ఈమెయిల్ ఐడీతో ఖాతా కనుగొనబడలేదు.', message: null, title: 'పాస్‌వర్డ్ మర్చిపోయారా?' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    resetTokens[token] = {
      userId: userRes.rows[0].id,
      expires: Date.now() + 15 * 60 * 1000 // 15 mins validity
    };

    const resetUrl = `${req.protocol}://${req.get('host')}/reset-password/${token}`;

    const mailOptions = {
      from: '"తెలుగు కథలు" <panduchalla2022@gmail.com>',
      to: target,
      subject: 'పాస్‌వర్డ్ రీసెట్ లింక్ - తెలుగు కథలు',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #333; max-width: 500px; border: 1px solid #ddd; border-radius: 8px;">
          <h2 style="color: #6a1b1a; text-align: center;">తెలుగు కథలు</h2>
          <hr style="border: 0; border-top: 1px solid #eee;">
          <p>నమస్కారం,</p>
          <p>మీ తెలుగు కథల ఖాతా కోసం పాస్‌వర్డ్ రీసెట్ అభ్యర్థన అందింది.</p>
          <p>క్రింది బటన్‌పై క్లిక్ చేసి మీ కొత్త పాస్‌వర్డ్‌ను సెట్ చేసుకోండి (ఈ లింక్ 15 నిమిషాలు మాత్రమే పనిచేస్తుంది):</p>
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" style="background-color: #6a1b1a; color: #ffffff; padding: 12px 25px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">పాస్‌వర్డ్ రీసెట్ చేయండి</a>
          </div>
          <p style="font-size: 12px; color: #888;">మీరు ఈ అభ్యర్థన చేయకపోతే ఈ మెయిల్‌ను సురక్షితంగా విస్మరించవచ్చు.</p>
        </div>
      `
    };

    await transporter.sendMail(mailOptions);
    res.render('forgot_password', { message: 'పాస్‌వర్డ్ రీసెట్ లింక్ మీ ఈమెయిల్‌కు పంపబడింది. ఇన్బాక్స్ లేదా స్పామ్ ఫోల్డర్ చెక్ చేయండి.', error: null, title: 'పాస్‌వర్డ్ మర్చిపోయారా?' });
  } catch (err) {
    console.error('Mail Send Error:', err);
    res.render('forgot_password', { error: 'ఈమెయిల్ పంపడంలో సాంకేతిక లోపం ఏర్పడింది.', message: null, title: 'పాస్‌వర్డ్ మర్చిపోయారా?' });
  }
});

// 11. Reset Password Routes
app.get('/reset-password/:token', (req, res) => {
  const { token } = req.params;
  const tokenData = resetTokens[token];

  if (!tokenData || Date.now() > tokenData.expires) {
    return res.send('లింక్ గడువు ముగిసింది లేదా చెల్లదు. దయచేసి మళ్ళీ ప్రయత్నించండి.');
  }

  res.render('reset_password', { token, error: null, title: 'కొత్త పాస్‌వర్డ్ సెట్ చేసుకోండి' });
});

app.post('/reset-password/:token', async (req, res) => {
  const { token } = req.params;
  const { password } = req.body;
  const tokenData = resetTokens[token];

  if (!tokenData || Date.now() > tokenData.expires) {
    return res.send('లింక్ గడువు ముగిసింది. దయచేసి మళ్ళీ ప్రయత్నించండి.');
  }

  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, tokenData.userId]);
    delete resetTokens[token];
    res.redirect('/login');
  } catch (err) {
    res.render('reset_password', { token, error: 'పాస్‌వర్డ్ మార్చడంలో లోపం జరిగింది.', title: 'కొత్త పాస్‌వర్డ్ సెట్ చేసుకోండి' });
  }
});

// 12. Dashboard
app.get('/my-dashboard', requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  try {
    const storiesRes = await pool.query(`
      SELECT 
        stories.*,
        (SELECT COUNT(*) FROM comments WHERE comments.story_id = stories.id) as total_comments
      FROM stories 
      WHERE stories.author_id = $1 
      ORDER BY stories.created_at DESC
    `, [userId]);

    const messagesRes = await pool.query(`
      SELECT 
        messages.*, 
        sender.username as sender_name,
        stories.title as story_title,
        stories.slug as story_slug
      FROM messages
      JOIN users sender ON messages.sender_id = sender.id
      LEFT JOIN stories ON messages.story_id = stories.id
      WHERE messages.receiver_id = $1
      ORDER BY messages.created_at DESC
    `, [userId]);

    res.render('dashboard', {
      myStories: storiesRes.rows || [],
      receivedMessages: messagesRes.rows || [],
      title: 'నా డాష్‌బోర్డ్'
    });
  } catch (err) {
    res.status(500).send('Dashboard Error');
  }
});

// 13. Submit Story
app.get('/submit', requireLogin, (req, res) => res.render('submit', { title: 'కథను సమర్పించండి' }));
app.post('/submit', requireLogin, upload.single('coverImage'), async (req, res) => {
  const { title, category, content } = req.body;
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
  const baseSlug = slugify(title, { lower: true, strict: true }) || 'story';
  const slug = `${baseSlug}-${Date.now().toString().slice(-4)}`;

  try {
    await pool.query(
      'INSERT INTO stories (title, slug, content, category, image_url, views, likes, author_id) VALUES ($1, $2, $3, $4, $5, 0, 0, $6)',
      [title, slug, content, category, imageUrl, req.session.user.id]
    );
    res.redirect(`/story/${slug}`);
  } catch (err) {
    res.status(500).send('కథను సేవ్ చేయడంలో లోపం తలెత్తింది');
  }
});

// 14. View Story
app.get('/story/:slug', async (req, res) => {
  try {
    await pool.query('UPDATE stories SET views = views + 1 WHERE slug = $1', [req.params.slug]);

    const storyRes = await pool.query(`
      SELECT stories.*, users.username AS author_name 
      FROM stories 
      LEFT JOIN users ON stories.author_id = users.id 
      WHERE slug = $1
    `, [req.params.slug]);

    const story = storyRes.rows[0];
    if (!story) return res.status(404).send('కథ కనుగొనబడలేదు');

    const commentsRes = await pool.query('SELECT * FROM comments WHERE story_id = $1 ORDER BY created_at DESC', [story.id]);

    res.render('story', { story, comments: commentsRes.rows || [], title: story.title });
  } catch (err) {
    res.status(500).send('Error loading story');
  }
});

// 15. Like Story
app.post('/story/:slug/like', async (req, res) => {
  await pool.query('UPDATE stories SET likes = likes + 1 WHERE slug = $1', [req.params.slug]);
  res.redirect(`/story/${req.params.slug}`);
});

// 16. Comments
app.post('/story/:slug/comment', async (req, res) => {
  try {
    const sRes = await pool.query('SELECT id FROM stories WHERE slug = $1', [req.params.slug]);
    const story = sRes.rows[0];
    if (!story) return res.status(404).send('కథ కనుగొనబడలేదు');

    const authorName = req.session.user ? req.session.user.username : (req.body.name || 'పాఠకుడు');
    await pool.query(
      'INSERT INTO comments (story_id, author_name, comment) VALUES ($1, $2, $3)',
      [story.id, authorName, req.body.comment]
    );
    res.redirect(`/story/${req.params.slug}`);
  } catch (err) {
    res.status(500).send('Comment error');
  }
});

// 17. Messages
app.post('/messages/send', requireLogin, async (req, res) => {
  const { receiver_id, story_id, message, redirect_url } = req.body;
  if (!message || !message.trim()) return res.redirect(redirect_url || '/');

  try {
    await pool.query(
      'INSERT INTO messages (story_id, sender_id, receiver_id, message) VALUES ($1, $2, $3, $4)',
      [story_id ? parseInt(story_id, 10) : null, req.session.user.id, parseInt(receiver_id, 10), message.trim()]
    );
    res.redirect(redirect_url || '/');
  } catch (err) {
    res.redirect(redirect_url || '/');
  }
});

// 18. Admin Panel
app.get('/admin/writers', requireLogin, async (req, res) => {
  if (!req.session.user.is_admin) return res.status(403).send('అడ్మిన్‌కు మాత్రమే అనుమతి ఉంది.');

  try {
    const writersRes = await pool.query(`
      SELECT 
        users.id, 
        users.username, 
        users.phone_email,
        users.upi_id, 
        users.bank_details,
        COUNT(stories.id) as total_stories,
        COALESCE(SUM(stories.views), 0) as total_views,
        COALESCE(SUM(stories.likes), 0) as total_likes
      FROM users
      LEFT JOIN stories ON users.id = stories.author_id
      GROUP BY users.id
      ORDER BY total_views DESC
    `);

    res.render('admin_writers', { writers: writersRes.rows || [], title: 'రచయితల వివరాలు (Admin)' });
  } catch (err) {
    res.status(500).send('Database error');
  }
});

// Admin Delete Story
app.post('/story/:id/delete', requireLogin, async (req, res) => {
  if (!req.session.user.is_admin) return res.status(403).send('అడ్మిన్‌కు మాత్రమే అనుమతి ఉంది.');
  try {
    await pool.query('DELETE FROM stories WHERE id = $1', [req.params.id]);
    res.redirect('/');
  } catch (err) {
    res.status(500).send('Delete error');
  }
});

// Sitemap
app.get('/sitemap.xml', async (req, res) => {
  try {
    const sRes = await pool.query('SELECT slug, created_at FROM stories');
    let xml = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
    xml += `<url><loc>${req.protocol}://${req.get('host')}/</loc><priority>1.0</priority></url>`;
    (sRes.rows || []).forEach(s => {
      xml += `<url><loc>${req.protocol}://${req.get('host')}/story/${s.slug}</loc><priority>0.8</priority></url>`;
    });
    xml += '</urlset>';
    res.header('Content-Type', 'application/xml');
    res.send(xml);
  } catch (err) {
    res.status(500).send('Sitemap error');
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Telugu Stories Platform running at http://localhost:${PORT}`));
