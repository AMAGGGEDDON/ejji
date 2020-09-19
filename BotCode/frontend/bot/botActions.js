const { Composer } = require('telegraf');
const Markup = require('telegraf/markup');
const Extra = require('telegraf/extra');
const { Languages, LoadReplies } = require('../replies/replies');
const rp = require('../replies/replies');
const { dbManagement, Schedule, User } = require('../../backend/dataBase/db');
const { parseString } = require('@alordash/parse-word-to-number');
const { parseDate, TimeList } = require('@alordash/date-parser');
const { FormStringFormatSchedule, FormDateStringFormat } = require('../formatting');
const { TimeListFromDate, ProcessParsedDate } = require('../../backend/timeProcessing');

let pendingSchedules = [];

/**
 * @param {Number} x 
 * @returns {Number} 
 */
Number.prototype.div = function (x) {
   return Math.floor(this / x);
}

/**@param {String} string
 * @returns {Languages}
 */
function DetermineLanguage(string) {
   let ruCount = [...string.matchAll(/[А-Яа-я]/g)].length;
   let enCount = [...string.matchAll(/[A-Za-z]/g)].length;
   return ruCount > enCount ? Languages.RU : Languages.EN;
}

function GetDeletingIDsIndex(chatID, deletingIDs) {
   if (deletingIDs.length) {
      for (let i in deletingIDs) {
         if (deletingIDs[i].chatID == chatID) {
            return i;
         }
      }
   }
   return false;
}
/**
 * @param {Number} id 
 * @returns {String} 
 */
function FormatChatId(id) {
   id = id.toString(10);
   if (id[0] == '-') {
      id = '_' + id.substring(1);
   }
   return id;
}

/**
 * @param {String} chatID 
 * @param {Number} tsOffset 
 * @param {dbManagement} db 
 * @param {Languages} language
 */
async function LoadSchedulesList(chatID, tsOffset, db, language) {
   let schedules = await db.ListSchedules(chatID);
   if (schedules.length > 0) {
      let answer = ``;
      schedules.sort((a, b) => a.id - b.id);
      for (let schedule of schedules) {
         schedule.target_date = +schedule.target_date;
         schedule.period_time = +schedule.period_time;
         schedule.max_date = +schedule.max_date;
         answer += `/${schedule.id}. ${FormStringFormatSchedule(schedule, schedule.period_time.div(1000), tsOffset, language)}\r\n`;
      }
      return answer;
   } else {
      const replies = LoadReplies(language);
      return replies.listIsEmpty;
   }
}

/**
 * @param {*} ctx 
 * @param {dbManagement} db 
 * @param {Languages} 
 */
async function DeleteSchedules(ctx, db) {
   let chatID = FormatChatId(ctx.chat.id)
   let msgText = ctx.message.text;
   const replies = LoadReplies(ctx.from.language_code);
   if (msgText.indexOf('all') == "/del ".length) {
      await db.ClearAllSchedules(chatID);
      await ctx.replyWithHTML(replies.cleared);
   } else {
      let nums = msgText.match(/[0-9]+/g);
      let ranges = msgText.match(/[0-9]+-[0-9]+/g);
      for (let i in nums) {
         nums[i] = parseInt(nums[i], 10);
      }
      for (let i in ranges) {
         let range = ranges[i];
         let index = range.indexOf('-');
         let leftNum = +range.substring(0, index);
         let rightNum = +range.substring(index + 1);
         if (leftNum > rightNum) {
            let t = leftNum;
            leftNum = rightNum;
            rightNum = t;
         }
         for (let j = leftNum; j <= rightNum && j - leftNum <= 10; j++) {
            nums.push(j);
         }
      }
      if (nums != null) {
         nums = nums.filter((item, pos) => {
            return nums.indexOf(item) == pos;
         });
         nums.sort((a, b) => a - b);

         let query = '';
         for (let i in nums) {
            let schedule = nums[i];
            query += `id = ${schedule} OR `;
         }
         query = query.substring(0, query.length - 4);
         await db.RemoveSchedules(chatID, query);
         await db.ReorderSchedules(chatID);
         let end = '';
         if (nums.length > 1) {
            end = 's';
         }
         try {
            ctx.replyWithHTML(rp.Deleted(nums.join(', '), false, ctx.message.from.language_code));
         } catch (e) {
            console.error(e);
         }
      } else {
         try {
            ctx.replyWithHTML(replies.invalidDelete);
         } catch (e) {
            console.error(e);
         }
      }
   }
}

/**
 * @param {*} ctx 
 * @param {dbManagement} db 
 * @param {Array.<Number>} tzPendingConfirmationUsers 
 */
async function StartTimeZoneDetermination(ctx, db, tzPendingConfirmationUsers) {
   let curTZ = await db.GetUserTZ(ctx.from.id);
   let reply = '';
   const language = await db.GetUserLanguage(ctx.from.id);
   const replies = LoadReplies(language);
   if (curTZ !== 0) {
      reply = replies.tzDefined + '<b>' + rp.TzCurrent(curTZ) + '</b>\r\n';
   }
   let isPrivateChat = ctx.chat.id >= 0;
   if (isPrivateChat) {
      reply += replies.tzConfiguration + '\r\n' + replies.tzViaLoc + '\r\n' + replies.tzManually;
      try {
         return ctx.replyWithHTML(reply, rp.TzDeterminationKeyboard(language));
      } catch (e) {
         console.error(e);
      }
   }
   if (tzPendingConfirmationUsers.indexOf(ctx.from.id) < 0) {
      tzPendingConfirmationUsers.push(ctx.from.id);
   }
   try {
      return await ctx.replyWithHTML(replies.tzGroupChatConfiguration);
   } catch (e) {
      console.error(e);
   }
}

/**
 * @param {Composer} bot 
 * @param {dbManagement} db 
 */
async function CheckExpiredSchedules(bot, db) {
   console.log('Checking expired schedules ' + new Date());
   db.sending = true;
   let expiredSchedules = await db.CheckActiveSchedules(Date.now());
   if (expiredSchedules.length > 0) {
      console.log(`expiredSchedules = ${JSON.stringify(expiredSchedules)}`);
      let ChatIDs = [];
      let deletingIDs = [];
      for (let schedule of expiredSchedules) {
         let chatID = schedule.chatid;
         if (chatID[0] == '_') {
            chatID = '-' + chatID.substring(1, chatID.length);
         }
         console.log(`Expired schedule = ${JSON.stringify(schedule)}`);
         if (!ChatIDs.includes(schedule.chatid)) {
            ChatIDs.push(schedule.chatid);
         }
         let mentionUser = '';
         if (schedule.username != 'none') {
            mentionUser = ' @' + schedule.username;
         }
         let language = await db.GetUserLanguage(+chatID);
         const replies = LoadReplies(language);
         try {
            let msg = await bot.telegram.sendMessage(+chatID, `⏰${mentionUser} "${schedule.text}"`, Extra.markup((m) =>
               m.inlineKeyboard([
                  m.callbackButton(replies.repeatSchedule, `repeat`)
               ]).oneTime()
            ));
            setTimeout(function (msg) {
               bot.telegram.editMessageReplyMarkup(msg.chat.id, msg.message_id, Extra.markup((m) =>
                  m.inlineKeyboard([]).removeKeyboard()
               ));
            }, repeatScheduleTime, msg);
         } catch (e) {
            console.error(e);
         }
         let shouldDelete = true;
         const nowSeconds = Date.now();
         schedule.target_date = +schedule.target_date;
         schedule.period_time = +schedule.period_time;
         schedule.max_date = +schedule.max_date;
         if (schedule.period_time >= 60 && schedule.max_date >= 60) {
            if (nowSeconds < schedule.max_date) {
               shouldDelete = false;
               await db.SetScheduleTargetDate(schedule.chatid, schedule.id, nowSeconds + schedule.period_time);
            }
         } else if (schedule.period_time >= 60 && schedule.max_date < 60) {
            shouldDelete = false;
            await db.SetScheduleTargetDate(schedule.chatid, schedule.id, nowSeconds + schedule.period_time);
         } else if (schedule.period_time < 60 && schedule.max_date >= 60) {
            if (nowSeconds < schedule.max_date) {
               shouldDelete = false;
               await db.SetScheduleTargetDate(schedule.chatid, schedule.id, schedule.max_date);
            }
         }

         if (shouldDelete) {
            let index = GetDeletingIDsIndex(schedule.chatid, deletingIDs);
            if (index === false) {
               deletingIDs.push({ s: `id = ${schedule.id} OR `, chatID: schedule.chatid });
            } else {
               deletingIDs[index].s += `id = ${schedule.id} OR `;
            }
         }
      }
      console.log('CHECKED, removing and reordering');
      for (let chatID of ChatIDs) {
         let index = GetDeletingIDsIndex(chatID, deletingIDs);
         if (index !== false) {
            let s = deletingIDs[index].s;
            s = s.substring(0, s.length - 4);
            await db.RemoveSchedules(chatID, s);
         }
         await db.ReorderSchedules(chatID);
      }
      console.log('Removed and reordered.');
   }
   db.sending = false;
   console.log(`Done checking expired schedules`);
}

/**
 * @param {*} ctx 
 * @param {dbManagement} db 
 * @param {Array.<Number>} tzPendingConfirmationUsers 
 */
async function ConfrimTimeZone(ctx, db, tzPendingConfirmationUsers) {
   let userId = ctx.from.id;
   let matches = ctx.message.text.match(/(\+|-|–|—|)([0-9])+:([0-9])+/g);
   let hours, minutes, negative, ts;
   const replies = LoadReplies(ctx.from.language_code);
   if (matches != null) {
      //Parse tz from msg;
      let offset = matches[0];
      let index = offset.indexOf(':');
      hours = parseInt(offset.substring(0, index));
      negative = offset[0].match(/-|–|—/g) != null;
      minutes = parseInt(offset.substring(index + 1));
      console.log(`Determining tz: offset = ${offset}, hours = ${hours}, minutes = ${minutes}, ts = ${ts}`);
   } else {
      matches = ctx.message.text.match(/(\+|-|–|—|)([0-9])+/g);
      if (matches != null) {
         let offset = matches[0];
         hours = parseInt(offset);
         minutes = 0;
         negative = offset[0].match(/-|–|—/g) != null;
         console.log(`Determining tz from only hour option: offset = ${offset}, hours = ${hours}, minutes = ${minutes}, ts = ${ts}`);
      }
   }
   if (matches != null) {
      let ts = hours * 3600;
      ts += minutes * 60 * (negative ? -1 : 1);
      if (!await db.HasUserID(userId)) {
         await db.AddUser(new User(userId, ts, db.defaultUserLanguage));
      } else {
         await db.SetUserTz(userId, ts);
      }
      tzPendingConfirmationUsers.splice(tzPendingConfirmationUsers.indexOf(ctx.from.id), 1);
      try {
         const schedulesCount = (await db.GetSchedules(FormatChatId(ctx.chat.id))).length;
         ctx.replyWithHTML(replies.tzDefined + '<b>' + rp.TzCurrent(ts) + '</b>\r\n',
            schedulesCount > 0 ? rp.ListKeyboard(ctx.from.language_code) : Markup.removeKeyboard());
      } catch (e) {
         console.error(e);
      }
   } else {
      console.log(`Can't determine tz in "${ctx.message.text}"`);
      try {
         return ctx.replyWithHTML(replies.tzInvalidInput, Extra.markup((m) =>
            m.inlineKeyboard([
               m.callbackButton(replies.tzCancel, 'tz cancel')
            ]).oneTime()
         ));
      } catch (e) {
         console.error(e);
      }
   }
}

/**
 * @param {*} ctx 
 * @param {dbManagement} db 
 */
async function HandleCallbackQuery(ctx, db) {
   console.log("got callback_query");
   const data = ctx.callbackQuery.data;
   let chatID = FormatChatId(ctx.callbackQuery.message.chat.id);
   const language = await db.GetUserLanguage(ctx.from.id);
   const replies = LoadReplies(language);
   switch (data) {
      case 'repeat':
         let text = ctx.callbackQuery.message.text.match(/"[\S\s]+"/);
         text = text[0].substring(1, text[0].length - 1);
         let username = 'none';
         if (chatID[0] === '_') {
            username = ctx.from.username;
         }
         let schedulesCount = await db.GetSchedules(chatID).length;
         let target_date = Date.now() + global.repeatScheduleTime;
         let schedule = new Schedule(chatID, schedulesCount, text, username, target_date, 0, 0);
         let tz = await db.GetUserTZ(ctx.from.id);

         try {
            await db.AddSchedule(schedule);
            ctx.editMessageText(text + '\r\n' + replies.remindSchedule + ' <b>' + FormDateStringFormat(new Date(target_date + tz * 1000), language) + '</b>', { parse_mode: 'HTML' });
         } catch (e) {
            console.error(e);
         }
         break;
      case 'confirm':
         try {
            if (typeof (pendingSchedules[chatID]) != 'undefined' && pendingSchedules[chatID].length > 0) {
               await db.AddSchedules(chatID, pendingSchedules[chatID]);
            }
         } catch (e) {
            console.error(e);
         } finally {
            pendingSchedules[chatID] = [];
            ctx.editMessageReplyMarkup(Extra.markup((m) =>
               m.inlineKeyboard([]).removeKeyboard()
            ));
         }
         break;
      case 'delete':
         ctx.deleteMessage();
         break;
      case 'unsubscribe':
         await db.SetUserSubscription(ctx.from.id, false);
         break;
      default:
         break;
   }
   try {
      ctx.answerCbQuery();
   } catch (e) {
      console.error(e);
   }
}

/**
 * @param {*} ctx 
 * @param {dbManagement} db 
 * @param {Array.<Number>} tzPendingConfirmationUsers 
 */
async function HandleTextMessage(ctx, db, tzPendingConfirmationUsers) {
   let chatID = FormatChatId(ctx.chat.id)
   let inGroup = chatID[0] === '_';
   let msgText = ctx.message.text;
   const language = DetermineLanguage(msgText);
   ctx.from.language_code = language;

   const mentionText = `@${ctx.me}`;
   const mentionIndex = msgText.indexOf(mentionText);
   const mentioned = mentionIndex != -1;
   if (mentioned) {
      msgText = msgText.substring(0, mentionIndex) + msgText.substring(mentionIndex + mentionText.length);
      if (msgText[mentionIndex - 1] == ' ' && msgText[mentionIndex] == ' ') {
         msgText = msgText.substring(0, mentionIndex) + msgText.substring(mentionIndex + 1);
      }
   }
   if (tzPendingConfirmationUsers.indexOf(ctx.from.id) >= 0) {
      ConfrimTimeZone(ctx, db, tzPendingConfirmationUsers);
   } else {
      let reply = '';
      if (msgText[0] == '/') {
         //#region DELETE CLICKED TASK 
         let scheduleId = parseInt(msgText.substring(1, msgText.length));
         if (!isNaN(scheduleId)) {
            await db.RemoveScheduleById(chatID, scheduleId);
            await db.ReorderSchedules(chatID);
            try {
               ctx.replyWithHTML(rp.Deleted(scheduleId.toString(10), false, ctx.from.language_code));
            } catch (e) {
               console.error(e);
            }
         }
         //#endregion
      } else {
         //#region PARSE SCHEDULE
         await db.SetUserLanguage(ctx.from.id, language);
         const replies = LoadReplies(language);
         let tz = await db.GetUserTZ(ctx.from.id);
         let prevalence = 50;
         let username = 'none';
         if (inGroup) {
            username = ctx.from.username;
            //            prevalence = 60;
         }
         let parsedDates = parseDate(parseString(msgText, 1), 1, prevalence);
         let count = 1;
         let shouldWarn = false;
         let alreadyScheduled = false;
         let schedulesCount = (await db.GetSchedules(chatID)).length;
         if (parsedDates.length == 0) {
            if (!inGroup) {
               reply += replies.errorScheduling;
            }
         } else {
            console.log(`schedulesCount = ${schedulesCount}`);
            let i = 1;
            for (let parsedDate of parsedDates) {
               if (parsedDates.length > 1) {
                  reply += `${i}. `;
               }
               let schedule = await db.GetScheduleByText(chatID, parsedDate.string);
               if (typeof (schedule) != 'undefined') {
                  reply += rp.Scheduled(schedule.text, FormDateStringFormat(new Date(+schedule.target_date + tz * 1000), language), language);
                  alreadyScheduled = true;
               } else {
                  if (count + schedulesCount < global.MaximumCountOfSchedules) {
                     let dateParams = ProcessParsedDate(parsedDate, tz);
                     if (typeof (dateParams) != 'undefined') {
                        if (parsedDate.string.length > 0) {
                           if (typeof (pendingSchedules[chatID]) == 'undefined') {
                              pendingSchedules[chatID] = [];
                           }
                           let newSchedule = new Schedule(
                              chatID,
                              0,
                              parsedDate.string,
                              username,
                              dateParams.target_date,
                              dateParams.period_time,
                              dateParams.max_date);
                           pendingSchedules[chatID].push(newSchedule);
                           count++;
                           reply += FormStringFormatSchedule(newSchedule, dateParams.period_time.div(1000), tz, language) + `\r\n`;
                        } else if (!inGroup) {
                           reply += replies.emptyString + '\r\n';
                        }
                     } else if (!inGroup) {
                        reply += replies.errorScheduling + '\r\n';
                     }
                     if (!inGroup && !(await db.HasUserID(ctx.from.id))) {
                        shouldWarn = true;
                     }
                  } else {
                     reply += replies.shouldRemove + '\r\n' + replies.maximumSchedulesCount + ` <b>${global.MaximumCountOfSchedules}</b>.`;
                  }
               }
               i++;
            }
         }
         if ((!inGroup || mentioned) && typeof (pendingSchedules[chatID]) != 'undefined' && pendingSchedules[chatID].length > 0) {
            await db.AddSchedules(chatID, pendingSchedules[chatID]);
            pendingSchedules[chatID] = [];
         }
         //#endregion
         if (reply != '') {
            if (shouldWarn) {
               reply += replies.tzWarning;
            }
            try {
               if (!mentioned && inGroup && typeof (schedule) === 'undefined' && parsedDates.length > 0) {
                  let keyboard;
                  if (!alreadyScheduled || parsedDates.length > 1) {
                     keyboard = Extra.markup((m) =>
                        m.inlineKeyboard([
                           m.callbackButton(replies.confirmSchedule, `confirm`),
                           m.callbackButton(replies.declineSchedule, `delete`)
                        ]).oneTime()
                     )
                  }
                  let msg = await ctx.replyWithHTML(reply, keyboard);
                  setTimeout(function (ctx, msg) {
                     if (typeof (msg) != 'undefined') {
                        let chatID = FormatChatId(msg.chat.id);
                        console.log('msg.message_id :>> ', msg.message_id);
                        ctx.telegram.deleteMessage(msg.chat.id, msg.message_id);
                        pendingSchedules[chatID] = [];
                     }
                  }, repeatScheduleTime, ctx, msg);
               } else {
                  ctx.replyWithHTML(reply, schedulesCount > 0 ? rp.ListKeyboard(language) : Markup.removeKeyboard());
               }
            } catch (e) {
               console.error(e);
            }
         }
      }
   }
}
//#endregion

module.exports = {
   GetDeletingIDsIndex,
   FormatChatId,
   LoadSchedulesList,
   DeleteSchedules,
   StartTimeZoneDetermination,
   CheckExpiredSchedules,
   HandleCallbackQuery,
   HandleTextMessage
}