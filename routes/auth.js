const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../database');
const { generateToken, authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.post('/login', (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        success: false,
        message: '用户名和密码不能为空'
      });
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);

    if (!user) {
      return res.status(401).json({
        success: false,
        message: '用户名或密码错误'
      });
    }

    const isValid = bcrypt.compareSync(password, user.password);
    if (!isValid) {
      return res.status(401).json({
        success: false,
        message: '用户名或密码错误'
      });
    }

    const token = generateToken(user);
    const dept = user.department_id
      ? db.prepare('SELECT id, name, code FROM departments WHERE id = ?').get(user.department_id)
      : null;

    const roleNames = {
      admin: '管理员',
      operator: '操作员',
      auditor: '审核员'
    };

    res.json({
      success: true,
      message: '登录成功',
      data: {
        token,
        user: {
          id: user.id,
          username: user.username,
          realName: user.real_name,
          role: user.role,
          roleName: roleNames[user.role],
          email: user.email,
          phone: user.phone,
          department: dept
        }
      }
    });
  } catch (err) {
    console.error('登录错误:', err);
    res.status(500).json({
      success: false,
      message: '登录失败：' + err.message
    });
  }
});

router.get('/me', authMiddleware, (req, res) => {
  try {
    const user = req.user;
    const dept = user.department_id
      ? db.prepare('SELECT id, name, code FROM departments WHERE id = ?').get(user.department_id)
      : null;

    const roleNames = {
      admin: '管理员',
      operator: '操作员',
      auditor: '审核员'
    };

    res.json({
      success: true,
      data: {
        id: user.id,
        username: user.username,
        realName: user.real_name,
        role: user.role,
        roleName: roleNames[user.role],
        email: user.email,
        phone: user.phone,
        department: dept
      }
    });
  } catch (err) {
    console.error('获取用户信息错误:', err);
    res.status(500).json({
      success: false,
      message: '获取用户信息失败：' + err.message
    });
  }
});

module.exports = router;
