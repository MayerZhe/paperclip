# Design Review Checklist

> **使用时机**: architect agent 对前端 story 进行设计审查时使用
> **使用方法**: 逐项检查，每项标记 ✅（通过）/ ❌（未通过）/ N/A（不适用），发现的问题备注在行尾

---

## 1. Design Tokens（设计令牌）
- [ ] 颜色：所有颜色引用是否来自设计令牌（CSS 变量），无硬编码色值
- [ ] 字体：字体族是否与设计规范一致（如 Circular, system-ui）
- [ ] 字号：所有 font-size 是否匹配设计令牌阶梯
- [ ] 间距：margin/padding/gap 是否使用规范间距（4px 网格）
- [ ] 圆角：border-radius 是否使用 sm/md/lg/pill token
- [ ] 阴影：box-shadow 是否使用 raised/focus token
- [ ] 动画：transition/animation 缓动函数是否匹配规范（cubic-bezier 值）

## 2. Typography（排版）
- [ ] 字体族：是否加载了正确的字体文件或 CDN 引用
- [ ] 字重：h1/h2/h3/p 的字重是否匹配设计（Regular 400 / Medium 500 / Bold 700）
- [ ] 行高：line-height 是否符合设计规范
- [ ] 字号层级：标题/正文/辅助文字的字号阶梯是否正确
- [ ] 字体回退：font-family fallback 链是否合理（如 `Circular, system-ui, sans-serif`）

## 3. Layout（布局）
- [ ] 网格对齐：列数和间距是否与设计网格一致
- [ ] 响应式断点：sm/md/lg/xl 断点值是否正确
- [ ] 容器宽度：max-width 是否匹配设计（如 1100px, 1280px）
- [ ] 侧边栏/顶部栏：宽度、高度是否与设计一致
- [ ] 内容区居中：是否使用正确的居中方式
- [ ] 滚动行为：overflow/scroll 区域是否正确

## 4. Component States（组件状态）
- [ ] Default：默认状态正确渲染
- [ ] Hover：悬停效果存在且与设计一致
- [ ] Active/Focus：激活和焦点指示器正确
- [ ] Disabled：禁用状态变灰且不可交互
- [ ] Loading：骨架屏/加载指示器存在且视觉正确
- [ ] Error：错误状态提示存在且不影响布局
- [ ] Empty：空状态（无数据）引导文案和占位图正确

## 5. Visual Hierarchy（视觉层次）
- [ ] 信息层级：最重要的信息是否最突出
- [ ] 视觉焦点：CTA 按钮/关键指标是否吸引注意力
- [ ] 留白：content 和 chrome 之间是否有足够的呼吸空间
- [ ] 分组：相关内容是否通过间距/边框/背景分组
- [ ] 视觉噪音：无多余装饰元素干扰信息传达

## 6. Accessibility（可访问性）
- [ ] 对比度：文字与背景对比度 ≥ 4.5:1（正文）/ 3:1（大标题）
- [ ] 焦点指示器：键盘导航的 focus ring 可见
- [ ] ARIA 标签：交互元素有正确的 aria-label 或 aria-labelledby
- [ ] 语义 HTML：使用正确的 heading/section/nav/main 标签
- [ ] 键盘导航：Tab/Enter/Escape 可用

## 7. Animation（动画）
- [ ] 过渡时长：是否使用规范时长（如 200ms, 300ms）
- [ ] 缓动函数：是否匹配项目缓动曲线（如 cubic-bezier(0.2,0,0,1)）
- [ ] 触发条件：动画触发时机正确（hover/scroll/mount）
- [ ] 性能：是否使用 transform/opacity（避免 layout thrashing）
- [ ] Reduced motion：是否尊重 `prefers-reduced-motion` 媒体查询

## 8. Cross-Reference（设计规范交叉对比）
- [ ] Figma 对比：与设计稿逐区域对比，无视觉差异
- [ ] 截图对比：Claude Preview 截图与原型截图排列对比
- [ ] 品牌元素：Logo、图标、品牌色是否正确
- [ ] 响应式：移动端/平板/桌面三视图均正确

---

## 审查结论

- [ ] **PASS** — 所有检查项通过，可进入质量门禁
- [ ] **PASS WITH NOTES** — 通过但有不影响功能的细微差异（记录在下）
- [ ] **FAIL** — 存在阻塞项，需修复后重新审查

### 阻塞项（FAIL 时填写）
| # | 维度 | 问题描述 | 修复建议 |
|---|------|---------|---------|
| 1 |      |         |         |

### 备注
