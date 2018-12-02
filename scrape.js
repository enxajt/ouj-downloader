'use strict'
const fs = require('fs');
const puppeteer = require('puppeteer');
const inquirer = require('inquirer');
//require('events').EventEmitter.defaultMaxListeners = 15;
const login = require('./login');
const consoleColor = require('./consoleColor');

let browser, page, cookies, categories, vodContents, baseCategories, downloadList;
let categoryId = 0;


const getAPI = async () => {
    browser = await puppeteer.launch();
    page = await browser.newPage();

    // クッキーをセット
    await page.setCookie(...cookies);

    process.stdout.write('データを取得中...');

    //  API取得 
    await page.goto('https://vod.ouj.ac.jp/v1/tenants/1/categories');
    categories = await page.evaluate(() => {
        return JSON.parse(document.querySelector("body").innerText);
    });

    await page.goto('https://vod.ouj.ac.jp/v1/tenants/1/vod-contents/');
    vodContents = await page.evaluate(() => {
        return JSON.parse(document.querySelector("body").innerText);
    });

    // 学部・大学院・コース等のベースとなるカテゴリー
    baseCategories = categories.filter(category => category.categoryId <= 29).reduce((result, current) => {
        result[current.categoryId] = current.name.split(' ')[1];
        return result;
    }, {});

    // APIをローカルに保存
    await fs.writeFileSync(__dirname + '/categories.json', JSON.stringify(categories));
    await fs.writeFileSync(__dirname + '/vod-contents.json', JSON.stringify(vodContents));
    await fs.writeFileSync(__dirname + '/base-categories.json', JSON.stringify(baseCategories));

    console.log('完了');

    await browser.close();
}

const selectCategory = async () => {
    let categoryChoices = categories.filter(category => category.parentId === categoryId).map(category => ({
        name: category.name.split(' ')[1],
        value: category.categoryId
    }));

    while (categoryChoices.length !== 0) {
        await inquirer
            .prompt([{
                type: 'list',
                name: 'categoryId',
                message: 'カテゴリーから選ぶ',
                choices: categoryChoices
            }])
            .then(async answers => {
                categoryId = answers.categoryId;
                categoryChoices = categories.filter(category => category.parentId === categoryId).map(category => ({
                    name: category.name.split(' ')[1],
                    value: category.categoryId
                }));
            })
    }
    let result = categories.filter(category => category.categoryId === categoryId).map(category => ({
        categoryId: category.categoryId,
        name: category.name.split(' ')[1],
        summary: category.summary,
        alias: category.alias,
        method: selectCategory
    }))[0];
    return confirmSubject(result);
}

const searchCategory = async () => {
    return inquirer
        .prompt([{
            type: 'input',
            name: 'searchWord',
            message: '検索する科目名、担当講師、科目コードを入力してください'
        }])
        .then(answers => {
            let result = categories
                .filter(category => category.categoryId > 29)
                .filter(category => category.name.indexOf(answers.searchWord) > -1 || category.summary.indexOf(answers.searchWord) > -1 || category.alias.indexOf(answers.searchWord) > -1)
                .map(category => ({
                    categoryId: category.categoryId,
                    parentId: category.parentId,
                    name: category.name.split(' ')[1],
                    summary: category.summary,
                    alias: category.alias,
                    method: searchCategory
                }))
            if (result.length > 1) {
                let categoryChoices = result.map(category => ({
                    name: `${baseCategories[category.parentId]} ${category.name}(${category.alias}) ${category.summary.split(' ').slice(1)} ${category.summary.split(' ')[0]}`,
                    value: category
                }));
                return inquirer
                    .prompt([{
                        type: 'list',
                        name: 'result',
                        message: `${result.length}件マッチしました。科目を選んでください。`,
                        choices: categoryChoices
                    }])
                    .then(answers => {
                        result = answers.result;
                        return confirmSubject(result);
                    })
            } else if (result.length === 1) {
                result = result[0];
                return confirmSubject(result);
            } else {
                console.log(consoleColor.red + `${answers.searchWord} にマッチする科目が見つかりませんでした。` + consoleColor.reset);
                return searchCategory();
            }
        })
}

const confirmSubject = async (result) => {
    return inquirer
        .prompt([{
            type: 'confirm',
            name: 'confirm',
            message: `Confirm\n${consoleColor.green}  科目コード: ${result.alias}\n  科目名: ${result.name}\n  担当講師: ${result.summary.split(' ').slice(1)}\n  メディア: ${result.summary.split(' ')[0].replace(/\((.*?)\)/g, '$1')}\n${consoleColor.reset}  この科目でよろしいですか？`
        }])
        .then(answers => {
            if (answers.confirm) {
                return result.categoryId;
            } else {
                // 選択された科目をリセット
                // categoryId = 0;
                //return result.method();
                return interactive();
            }
        })
}

const selectChapters = async (categoryId) => {
    categoryId = categoryId;
    const videos = vodContents.filter(video => video.categoryId === categoryId).sort((a, b) => a.alias - b.alias)
    const checkList = videos.map(video => ({
        name: video.title,
        value: video,
        short: video.alias,
        checked: true
    }))
    return inquirer
        .prompt([{
            type: 'checkbox',
            name: 'downloadList',
            message: 'ダウンロードするチャプターを選択してください',
            choices: checkList
        }])
        .then(async answers => {
            downloadList = answers.downloadList;
            // 1つも選択されなかったとき
            if (downloadList.length === 0) {
                await inquirer
                    .prompt([{
                        type: 'confirm',
                        name: 'confirm',
                        message: consoleColor.red + 'チャプターが選択されていません。もう一度選択しますか？' + consoleColor.reset
                    }])
                    .then(answers => {
                        if (answers.confirm) {
                            selectChapters();
                        } else {
                            return;
                        }
                    })
            };
        })
}

const addTicket = async (downloadList, cookies) => {
    // downloadList が空のときはundefinedを返す
    if (downloadList.length === 0) return;

    // authTicketとexistsSamiFileを downloadList に追加
    process.stdout.write('ダウンロードリストを取得中...');
    for (let i = 0; i < downloadList.length; i++) {
        const browser = await puppeteer.launch();
        const page = await browser.newPage();
        await page.setCookie(...cookies);
        await page.goto(`https://vod.ouj.ac.jp/v1/tenants/1/vod-contents/${downloadList[i].contentId}/video-src?hls=false`);
        downloadList[i] = Object.assign(downloadList[i], (await page.evaluate(() => {
            const videosrc = JSON.parse(document.querySelector("body").innerText);
            return {
                authTicket: videosrc.x1_0VideoSource.videoSrc.match(/authTicket=(.*?)&/, '$1')[1],
                existsSamiFile: videosrc.existsSamiFile
            };
        })));
        await browser.close();
    }
    console.log('完了');
    return downloadList;
}

const interactive = async () => {
    // 選択された科目をリセット
    categoryId = 0;
    await inquirer
        .prompt([{
            type: "list",
            name: "selectionMethod",
            message: "ダウンロードしたい科目の選択方法を選んでください",
            choices: [{
                name: "検索(科目名、担当講師、科目コード)",
                value: 0
            }, {
                name: 'カテゴリーから選ぶ',
                valie: 1
            }]
        }, ])
        .then(async answers => {
            const selectionMethod = answers.selectionMethod;
            categoryId = selectionMethod ? await selectCategory() : await searchCategory();
            await selectChapters(categoryId);
        })
}

const init = async () => {
    cookies = await login();

    // API読み込み
    try {
        categories = JSON.parse(fs.readFileSync(__dirname + '/categories.json', 'utf8'));
        vodContents = JSON.parse(fs.readFileSync(__dirname + '/vod-contents.json', 'utf8'));
        baseCategories = JSON.parse(fs.readFileSync(__dirname + '/base-categories.json', 'utf8'));
    } catch (error) {
        await getAPI();
    }

    await interactive();
    const result = await addTicket(downloadList, cookies);
    console.log('ログアウトしました。');
    return result;
}

//init();
module.exports = init;