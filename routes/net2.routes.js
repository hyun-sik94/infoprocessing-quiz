const express = require('express');
const router = express.Router();
const net2Controller = require('../controllers/net2.controller');

// GET  /api/net2/rounds?type={written|practical}
router.get('/rounds', net2Controller.getRounds);

// POST /api/net2/new
router.post('/new', net2Controller.getNewQuiz);

// POST /api/net2/check-answer
router.post('/check-answer', net2Controller.checkAnswer);

// POST /api/net2/submit
router.post('/submit', net2Controller.submitQuiz);

// GET  /api/net2/search?query=&type=&field=
router.get('/search', net2Controller.searchQuiz);

module.exports = router;

