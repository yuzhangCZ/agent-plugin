# AI PR Reviewer 测试文件

这是一个用于测试 AI 代码审查功能的文件。

## 测试内容

- ✅ AI 是否能正确识别文件变更
- ✅ AI 是否能用中文输出审查意见
- ✅ AI 是否能给出合理的评分和建议

## 测试代码示例

```javascript
// 这是一个测试函数，故意留了一些问题让 AI 发现
function testFunction() {
    var x = 1;  // 应该用 let/const
    console.log("Hello AI Reviewer!");
    
    // TODO: AI 应该能发现这个潜在问题
    if (x = 2) {  // 这是赋值不是比较！
        return true;
    }
    
    return false;
}
```

## 期望的 AI 审查意见

1. 指出 `var` 应该用 `const` 或 `let`
2. 发现 `if (x = 2)` 是赋值不是比较
3. 给出代码改进建议

---

**测试时间**: 2026-03-20
**测试人员**: @tesgg
