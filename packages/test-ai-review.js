// AI PR Reviewer 测试文件 - JavaScript 版本
// 这个文件包含一些故意的代码问题，用于测试 AI 审查功能

function testFunction() {
    var x = 1;  // 问题 1: 应该用 let/const
    
    console.log("Hello AI Reviewer!");
    
    // 问题 2: 这是赋值不是比较！
    if (x = 2) {
        return true;
    }
    
    // 问题 3: 未使用的变量
    var unused = "never used";
    
    // 问题 4: 缺少错误处理
    fetch('https://api.example.com/data')
        .then(res => res.json())
        .then(data => console.log(data));
    
    return false;
}

// 问题 5: 潜在的安全问题 - eval
function dangerousEval(userInput) {
    eval(userInput);
}

// 问题 6: 硬编码的敏感信息
const API_KEY = "sk-1234567890abcdef";

module.exports = { testFunction, dangerousEval };
// Final test - AI review verification
// Trigger new AI review test
