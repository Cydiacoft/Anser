// ==UserScript==
// @name         Anser - 自动答题与题库抓取助手
// @namespace    http://tampermonkey.net/
// @version      0.2
// @description  利用油猴提取网页题目，抓取题库（在线学习模式）+ 自动答题（考试模式）
// @author       Github_Cydiacoft
// @match        *://njtd.dxsaqxx.top/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
    'use strict';

    // 【关键修复】如果当前处于 frameset 框架集页面，立刻中止，坚决不在里面注入悬浮窗导致页面被撑破崩溃！
    if (document.body && document.body.tagName && document.body.tagName.toUpperCase() === 'FRAMESET') {
        return;
    }
    // 【关键修复2】跳过尺寸过小的边栏 (left.html) 和顶部标题栏 (head.html)，只在右侧主区域运行
    if (window.innerWidth < 400 || window.innerHeight < 300) {
        return;
    }

    // 设置项
    const CONFIG = {
        serverUrl: "http://127.0.0.1:5000",
        get isAutoMode() { return GM_getValue('anser_auto_mode', false); },
        set isAutoMode(val) { GM_setValue('anser_auto_mode', val); }
    };

    let processedQuestion = null;
    let autoTimer = null;
    const VIDEO_IDS = [766, 767, 768, 769, 770];
    let videoPopupAnswered = false;

    // 创建悬浮窗 UI
    const createUI = () => {
        const panel = document.createElement('div');
        panel.id = 'anser-panel';
        panel.innerHTML = `
            <div style="padding: 10px; background: #333; color: white; border-radius: 5px 5px 0 0; font-weight: bold; font-size: 14px; cursor: move;" id="anser-header">
                Anser 自动化助手
            </div>
            <div id="anser-content" style="padding: 10px; max-height: 250px; overflow-y: auto; font-size: 13px; color: #333;">
                正在侦测当前模式...
            </div>
            <div style="padding: 10px; border-top: 1px solid #eee; display: flex; gap: 5px; flex-wrap: wrap;">
                <button id="anser-btn-scrape" style="flex:1; padding:6px; background:#28a745; color:white; border:none; border-radius:3px; cursor:pointer; min-width:120px;">开启自动抓库</button>
                <button id="anser-btn-exam"   style="flex:1; padding:6px; background:#007bff; color:white; border:none; border-radius:3px; cursor:pointer; min-width:120px;">当前题获取答案</button>
                <button id="anser-btn-auto-exam" style="flex:1; padding:6px; background:#6f42c1; color:white; border:none; border-radius:3px; cursor:pointer; min-width:120px;">开启自动考试</button>
            </div>
        `;


        GM_addStyle(`
            #anser-panel {
                position: fixed;
                top: 50px;
                right: 20px;
                width: 300px;
                background: white;
                box-shadow: 0 4px 15px rgba(0,0,0,0.2);
                border-radius: 5px;
                z-index: 999999;
                font-family: system-ui, -apple-system, sans-serif;
            }
            #anser-panel button:hover { opacity: 0.9; }
        `);

        document.body.appendChild(panel);

        // ---------- 增加悬浮窗拖拽功能 ----------
        const header = document.getElementById('anser-header');
        let isDragging = false;
        let offsetX, offsetY;

        header.addEventListener('mousedown', (e) => {
            isDragging = true;
            offsetX = e.clientX - panel.offsetLeft;
            offsetY = e.clientY - panel.offsetTop;
            document.body.style.userSelect = 'none'; // 防止拖动时选中页面文本
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            panel.style.left = (e.clientX - offsetX) + 'px';
            panel.style.top = (e.clientY - offsetY) + 'px';
            panel.style.right = 'auto'; // 解除原本靠右固定
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
            document.body.style.userSelect = '';
        });
        // ----------------------------------------

        let btnScrape = document.getElementById('anser-btn-scrape');

        // 渲染初始按钮状态
        if (CONFIG.isAutoMode) {
            btnScrape.innerText = "停止自动抓库";
            btnScrape.style.background = "#dc3545";
        }

        btnScrape.addEventListener('click', (e) => {
            CONFIG.isAutoMode = !CONFIG.isAutoMode;
            if (CONFIG.isAutoMode) {
                e.target.innerText = "停止自动抓库";
                e.target.style.background = "#dc3545";
                updatePanel("自动抓库已开启！等待检测...");
            } else {
                e.target.innerText = "开启自动抓库";
                e.target.style.background = "#28a745";
                updatePanel("已停止自动抓库。");
            }
        });

        document.getElementById('anser-btn-exam').addEventListener('click', () => {
            handleExamMode(false); // 单次查询，不自动跳题
        });

        // 自动考试按钮逻辑
        let btnAutoExam = document.getElementById('anser-btn-auto-exam');
        let autoExamMode = GM_getValue('anser_auto_exam', false);
        if (autoExamMode) {
            btnAutoExam.innerText = '停止自动考试';
            btnAutoExam.style.background = '#dc3545';
        }
        btnAutoExam.addEventListener('click', (e) => {
            autoExamMode = !autoExamMode;
            GM_setValue('anser_auto_exam', autoExamMode);
            if (autoExamMode) {
                e.target.innerText = '停止自动考试';
                e.target.style.background = '#dc3545';
                updatePanel('⚡ 自动考试已开启！正在获取答案...');
                handleExamMode(true); // 立刻执行一次
            } else {
                e.target.innerText = '开启自动考试';
                e.target.style.background = '#6f42c1';
                updatePanel('已停止自动考试。');
            }
        });
    };

    const updatePanel = (htmlContent) => {
        const el = document.getElementById('anser-content');
        if (el) el.innerHTML = htmlContent;
    };

    /**
     * 核心逻辑：从 DOM 中尝试提取题目文本
     * 这里由于无法直接看到网页源码，采用基于整个页面文本或通用的方法分析
     */
    const extractContent = () => {
        // ========== 提取逻辑 ==========
        // 已根据网站实际 DOM (id="trTestTypeContent1") 进行精准适配

        const table = document.getElementById('trTestTypeContent1');
        if (!table) {
            return {
                mode: 'failed',
                question_text: '未能找到题目表格 (trTestTypeContent1)',
                reference_answer: null
            };
        }

        let isLearningMode = table.innerText.includes('参考答案');

        // table.rows[0] 包含了完整题目： "1.小王接到陌生客服电话...（） 共 150 题"
        let qTextRaw = table.rows[0].innerText || "";
        // 清理前缀序号和结尾的“共 xxx 题”字样
        let qText = qTextRaw.replace(/^[0-9]+\s*\./, '').replace(/共\s*[0-9]+\s*题/gi, '').trim();

        // 提取参考答案
        let referenceAnswer = null;
        let finalAnswerText = null;
        if (isLearningMode) {
            let match = table.innerText.match(/参考答案\s*[:：]\s*([A-Za-z,，]+|[正确错误对错]+)/);
            if (match && match[1]) {
                let rawAns = match[1].trim();
                
                // 判断题（正确/错误）不涉及到按首字母还原的逻辑
                if (/[正确错误对错]+/.test(rawAns)) {
                    finalAnswerText = rawAns;
                } else {
                    // 转大写并去掉所有的逗号空格，比如 "A,B" 变成 "AB"
                    referenceAnswer = rawAns.replace(/[,，\s]/g, '').toUpperCase(); 
                    
                    let extractedTexts = [];
                    // 遍历表格的所有行，寻找 A. B. C. D. 开头的选项内容
                    for(let i = 1; i < table.rows.length; i++) {
                        let rowText = table.rows[i].innerText.trim();
                        let letterMatch = rowText.match(/^([A-Z])\s*[.、]/i); 
                        if (letterMatch && letterMatch[1]) {
                            let letter = letterMatch[1].toUpperCase();
                            // 如果这个字母在“参考答案”字符串里包含，说明它是正确选项的文本
                            if (referenceAnswer.includes(letter)) {
                                // 截取纯文本（去掉 "A. " 等前缀）
                                let pureText = rowText.replace(/^([A-Z])\s*[.、]/i, '').trim();
                                extractedTexts.push(pureText);
                            }
                        }
                    }
                    
                    if (extractedTexts.length > 0) {
                        finalAnswerText = extractedTexts.join('  |||  '); // 多选题用分割符拼接全部文本
                    } else {
                        finalAnswerText = referenceAnswer; // 退化兜底
                    }
                }
            }
        }

        return {
            mode: isLearningMode ? 'learning' : 'exam',
            question_text: qText,
            reference_answer: finalAnswerText, // 此时保存的已经是实际的答案句子文本了
            raw_text: table.innerText.substring(0, 50)
        };
    };

    // 寻找“下一题”按钮并点击
    const clickNextButton = () => {
        // 这是页面自带的全局 JS 函数，可以更直接地翻页，如果不行再退化为找按钮
        if (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.nextbtnclick === 'function') {
            unsafeWindow.nextbtnclick();
            return true;
        } else if (typeof window.nextbtnclick === 'function') {
            window.nextbtnclick();
            return true;
        }

        const btns = document.querySelectorAll('a, button, input[type="button"], input[type="submit"]');
        for (let btn of Array.from(btns)) {
            let val = btn.innerText || btn.value;
            if (val && val.includes('下一题')) {
                btn.click();
                return true;
            }
        }
        return false;
    };

    // 自动抓取并提交题库
    const handleLearningMode = (data) => {
        if (!data.reference_answer) {
            return;
        }

        // 防止同一个题目在一秒钟内重复发送
        if (processedQuestion === data.question_text) return;
        processedQuestion = data.question_text;

        updatePanel(`正自动录入此题...<br/>答案：<b>${data.reference_answer}</b>`);

        GM_xmlhttpRequest({
            method: "POST",
            url: `${CONFIG.serverUrl}/api/save_answer`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({
                question_text: data.question_text,
                answer: data.reference_answer
            }),
            onload: function (res) {
                if (res.status === 200) {
                    updatePanel(`录入完成！即将前往下一题...`);
                    setTimeout(() => {
                        if (CONFIG.isAutoMode) {
                            clickNextButton();
                        }
                    }, 500); // 半秒后点击下一题，因为已经有了setInterval的节奏保障，不用等太久
                } else {
                    updatePanel(`录入失败 HTTP ${res.status}`);
                    processedQuestion = null; // 允许重试
                }
            },
            onerror: () => {
                updatePanel('请求本地服务失败，请确保后台启动。');
                processedQuestion = null;
            }
        });
    };

    // 考试模式：请求服务器进行比对，并自动勾选
    const handleExamMode = (autoNext = false) => {
        // 支持两种表格 ID：在线学习用 trTestTypeContent1，考试页面同样
        let table = document.getElementById('trTestTypeContent1');

        // 如果找不到表格，尝试通过 radio/checkbox 对应的最近父级 table 元素定位
        if (!table) {
            const firstInput = document.querySelector('input[type="radio"], input[type="checkbox"]');
            if (firstInput) {
                table = firstInput.closest('table');
            }
        }

        if (!table) {
            updatePanel('⚠️ 未找到题目表格，请确认在考试页面');
            return;
        }

        // 提取题目文本——先找包含 <a id="l1"> 的行，否则用 rows[0]
        let qText = '';
        const qLink = table.querySelector('a[id^="l"]');
        if (qLink) {
            qText = qLink.parentElement ? qLink.parentElement.innerText : qLink.closest('tr').innerText;
        } else if (table.rows[0]) {
            qText = table.rows[0].innerText;
        }
        qText = qText.replace(/^\d+[.\s]+/, '').replace(/共\s*\d+\s*题/gi, '').replace(/分\d+分/, '').trim();
        if (!qText) return;

        // 收集当前页面所有选项 {letter -> 纯文字}
        const optionMap = {};
        for (let i = 1; i < table.rows.length; i++) {
            const inp = table.rows[i].querySelector('input[type="radio"], input[type="checkbox"]');
            if (!inp) continue;
            const letter = inp.value ? inp.value.toUpperCase() : null;
            if (!letter) continue;
            const rowText = table.rows[i].innerText.replace(/^[A-Z]\s*[.\u3001]/i, '').trim();
            optionMap[letter] = rowText;
        }

        updatePanel(`正在查询答案...<br>题目: ${qText.substring(0, 25)}...`);

        GM_xmlhttpRequest({
            method: "POST",
            url: `${CONFIG.serverUrl}/api/get_answer`,
            headers: { "Content-Type": "application/json" },
            data: JSON.stringify({ question_text: qText }),
            onload: function (res) {
                if (res.status !== 200) return;
                const result = JSON.parse(res.responseText);
                if (!result.answer) return;

                // 题库存的是选项文字，需要反查出对应字母
                const storedParts = result.answer.split('|||').map(s => s.trim());
                let lettersToCheck = [];

                for (const [letter, optText] of Object.entries(optionMap)) {
                    const isMatch = storedParts.some(part =>
                        part.length > 2 && (optText.includes(part) || part.includes(optText))
                    );
                    if (isMatch) lettersToCheck.push(letter);
                }

                // 退化策略1：如果文字匹配失败，尝试把题库答案直接当字母用
                if (lettersToCheck.length === 0) {
                    const rawLetters = result.answer.replace(/[^A-Za-z]/g, '').toUpperCase().split('');
                    if (rawLetters.length > 0 && rawLetters.every(l => Object.keys(optionMap).includes(l))) {
                        lettersToCheck = rawLetters;
                    }
                }

                // 退化策略2：判断题（正确/错误）
                if (lettersToCheck.length === 0 && /正确|错误/.test(result.answer)) {
                    for (const [letter, optText] of Object.entries(optionMap)) {
                        if (result.answer.includes('正确') && optText.includes('正确')) lettersToCheck.push(letter);
                        if (result.answer.includes('错误') && optText.includes('错误')) lettersToCheck.push(letter);
                    }
                }

                updatePanel(`
                    <div>来源: <b>${result.source === 'local_db' ? '题库匹配' : 'AI兜底'}</b></div>
                    <div style="color:#28a745; font-weight:bold; margin-top:4px;">勾选选项: <b>${lettersToCheck.join(', ') || '(未识别)'}</b></div>
                    <div style="font-size:12px; color:#888; margin-top:4px; word-break:break-all;">题库: ${result.answer.replace(/\|\|\|/g, ' / ').substring(0, 80)}</div>
                `);

                // 点击正确选项
                for (let i = 1; i < table.rows.length; i++) {
                    const inp = table.rows[i].querySelector('input[type="radio"], input[type="checkbox"]');
                    if (!inp) continue;
                    const letter = inp.value ? inp.value.toUpperCase() : null;
                    if (!letter) continue;
                    const shouldCheck = lettersToCheck.includes(letter);
                    if (shouldCheck && !inp.checked) inp.click();
                    else if (!shouldCheck && inp.checked && inp.type === 'checkbox') inp.click();
                }

                // 如果开了全自动模式，2秒后跳下一题（无论是否匹配到答案都前进）
                if (autoNext) {
                    const delay = lettersToCheck.length > 0 ? 2000 : 800; // 匹配到答案等2秒，未匹配0.8秒就跳过
                    setTimeout(() => {
                        // 首先尝试调用页面内置的 nextbtnclick 函数
                        if (typeof unsafeWindow !== 'undefined' && typeof unsafeWindow.nextbtnclick === 'function') {
                            unsafeWindow.nextbtnclick();
                        } else if (typeof window.nextbtnclick === 'function') {
                            window.nextbtnclick();
                        } else {
                            // 如果没有 JS 函数，直接找“下一题”按钮并点击
                            const allBtns = document.querySelectorAll('input[type="button"], input[type="submit"], button, a');
                            for (const btn of Array.from(allBtns)) {
                                const val = btn.value || btn.innerText || '';
                                if (val.includes('下一题') || val.includes('下一')) {
                                    btn.click();
                                    break;
                                }
                            }
                        }
                    }, delay);
                }
            },
            onerror: () => {
                updatePanel('请求本地服务失败，请确保后台已启动。');
            }
        });
    };

    // 初始化：插入浮窗
    setTimeout(() => {
        createUI();

        // ========== 核心心脏：心跳轮询 ==========
        // 每 1.5 秒检查一次状态，防止网页是单页应用假刷新或者 setTimeout 失效
        setInterval(() => {
            const url = window.location.href;

            // ===== 模式1：视频播放页 viewfilm.aspx =====
            if (url.includes('viewfilm.aspx')) {
                // 1a. 检测防挂机弹窗（div#wo）并自动答题
                const woDiv = document.getElementById('wo');
                if (woDiv && woDiv.style.display !== 'none' && woDiv.innerText.includes('观看视频')) {
                    if (!videoPopupAnswered) {
                        videoPopupAnswered = true;
                        // 选「正确」
                        const correctRadio = Array.from(woDiv.querySelectorAll('input[type="radio"]'))
                            .find(r => r.value && r.value.includes('正确'));
                        if (correctRadio && !correctRadio.checked) correctRadio.click();

                        // 稍等0.5秒后再提交，避免点太快
                        setTimeout(() => {
                            const submitBtn = document.getElementById('Button1')
                                || Array.from(woDiv.querySelectorAll('input[type="button"]')).find(b => b.value === '提交');
                            if (submitBtn && !submitBtn.disabled) {
                                submitBtn.click();
                                updatePanel('✅ 防挂机弹窗已自动答题，继续播放...');
                            }
                            // 弹窗关闭后重置标志
                            setTimeout(() => { videoPopupAnswered = false; }, 3000);
                        }, 500);
                    }
                    return; // 弹窗期间不执行其他逻辑
                }

                // 1b. 如果开了全自动模式，检测视频是否播放完毕（video结束 or 进度条到底）
                if (CONFIG.isAutoMode) {
                    const video = document.getElementById('video1');
                    if (video && video.ended) {
                        updatePanel('🎬 视频播放完毕！3秒后返回视频列表...');
                        // 找到返回按钮 Button2
                        setTimeout(() => {
                            const backBtn = document.getElementById('Button2')
                                || Array.from(document.querySelectorAll('input[type="submit"]')).find(b => b.value === '返回');
                            if (backBtn) {
                                backBtn.click();
                            } else {
                                // 找不到返回按钮，直接跳转到视频列表页
                                window.location.href = 'http://njtd.dxsaqxx.top/shipin/splb.aspx';
                            }
                        }, 3000);
                    }
                }
                return;
            }

            // ===== 模式2：视频列表页 splb.aspx =====
            if (url.includes('splb.aspx') && CONFIG.isAutoMode) {
                // 取出上次播放到的视频索引，循环选下一个
                let lastIdx = GM_getValue('anser_last_video_idx', -1);
                let nextIdx = (lastIdx + 1) % VIDEO_IDS.length;
                let nextId = VIDEO_IDS[nextIdx];
                GM_setValue('anser_last_video_idx', nextIdx);
                updatePanel(`🎬 自动播放第 ${nextIdx + 1}/${VIDEO_IDS.length} 个视频 (id=${nextId})...`);
                // 1.5秒后跳转，给页面一点时间稳定
                setTimeout(() => {
                    window.location.href = `http://njtd.dxsaqxx.top/shipin/viewfilm.aspx?id=${nextId}`;
                }, 1500);
                return;
            }

            // ===== 模式3：在线学习 / 考试模式 =====
            // 防挂机弹窗（在线学习页也可能有）
            const woDiv2 = document.getElementById('wo');
            if (woDiv2 && woDiv2.style.display !== 'none' && woDiv2.innerText.includes('观看视频')) {
                const correctRadio = Array.from(woDiv2.querySelectorAll('input[type="radio"]'))
                    .find(r => r.value && r.value.includes('正确'));
                if (correctRadio && !correctRadio.checked) correctRadio.click();
                const submitBtn = document.getElementById('Button1')
                    || Array.from(woDiv2.querySelectorAll('input[type="button"]')).find(b => b.value === '提交');
                if (submitBtn && !submitBtn.disabled) submitBtn.click();
            }

            // ===== 模式4：考试页面 StartExamOne.aspx - 心跳全自动中 =====
            if (url.includes('StartExamOne.aspx') || url.includes('StartExam')) {
                const autoExam = GM_getValue('anser_auto_exam', false);
                if (autoExam) {
                    // 检测题目是否已处理过（防止在同一题上无限读取）
                    const currentTable = document.getElementById('trTestTypeContent1')
                        || (() => { const inp = document.querySelector('input[type="radio"], input[type="checkbox"]'); return inp ? inp.closest('table') : null; })();
                    if (currentTable) {
                        const qLink = currentTable.querySelector('a[id^="l"]');
                        const qSnippet = qLink ? qLink.parentElement.innerText.substring(0, 30) : (currentTable.rows[0] ? currentTable.rows[0].innerText.substring(0, 30) : '');
                        if (qSnippet && qSnippet !== processedQuestion) {
                            processedQuestion = qSnippet; // 防止同一题重复调用
                            handleExamMode(true);
                        }
                    }
                }
                return;
            }

            // 首先判断是否在等待
            if (!CONFIG.isAutoMode) return;

            const data = extractContent();
            if (data.mode === 'learning') {
                if (processedQuestion !== data.question_text) {
                    handleLearningMode(data);
                }
            }
        }, 1500);

    }, 800);

})();
