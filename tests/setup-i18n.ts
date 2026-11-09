// 产品默认英文；现有单测断言的是中文文案，所以统一固定成 zh-CN（--import 先于每个测试文件执行）
import { setLang } from '../src/core/i18n';

setLang('zh-CN');
