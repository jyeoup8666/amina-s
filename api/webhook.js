// ─────────────────────────────────────────────────────────────
// 시설요청 봇 + 간호팀 전실안내 겸용 웹훅
// - 같은 라인 봇 계정이 "시설요청방"과 "간호팀 전실안내방" 두 곳에 모두 들어있는 구조입니다.
// - event.source.groupId 로 어느 방에서 온 메시지인지 구분해서 처리를 분기합니다.
//
// [설정 완료] 입퇴원방(전실 안내방)의 groupId를 아래에 채워넣었습니다.
//   이 값과 일치하는 방에서 온 메시지는 시설요청 로직을 아예 타지 않고(continue로 완전히 건너뜀)
//   전실 처리 로직으로만 갑니다. 나머지 방(시설요청방 등)은 기존 로직 그대로 처리됩니다.
// ─────────────────────────────────────────────────────────────

const NURSING_GROUP_ID = 'C7301eb7ce6143bfaa4b4f50d57792f95';

const firebaseUrl = 'https://facility-check-74a17-default-rtdb.firebaseio.com/facility_requests';
const transferFirebaseUrl = 'https://facility-check-74a17-default-rtdb.firebaseio.com/patient_transfers';

// ───────────── 전실 메시지 파싱 (간호팀 방 전용) ─────────────
const ROOM_RE = () => /(\d{3})\s*호?\s*-\s*(\d{1,2})\s*호?|(\d{3})\s*호?/g;
const FILLER_RE = /^(?:\s|호|로|으로|자리|이동|변경|하여|>|<|→|-->|->)+$/;

function findRooms(text) {
  const rooms = [];
  const re = ROOM_RE();
  let m;
  while ((m = re.exec(text)) !== null) {
    const num = m[1] || m[3];
    const sub = m[2];
    rooms.push({ raw: sub ? `${num}-${sub}` : num, start: m.index, end: m.index + m[0].length });
  }
  return rooms;
}

function findNameCandidates(text) {
  const names = [];
  let m;
  const re1 = /([가-힣]{2,4}\d?)님/g;
  while ((m = re1.exec(text)) !== null) {
    names.push({ name: m[1], start: m.index });
  }
  const re2 = /([가-힣]{2,4}\d?)\s*(?:-->|→|->)/g;
  while ((m = re2.exec(text)) !== null) {
    if (!names.some(n => n.start === m.index)) {
      names.push({ name: m[1], start: m.index });
    }
  }
  names.sort((a, b) => a.start - b.start);
  return names;
}

function extractTransfers(text) {
  const rooms = findRooms(text);
  const names = findNameCandidates(text);
  const results = [];

  const verbRe = /전실/g;
  let vm;
  while ((vm = verbRe.exec(text)) !== null) {
    const anchorIdx = vm.index;
    let destRoom = null;
    for (let i = rooms.length - 1; i >= 0; i--) {
      const r = rooms[i];
      if (r.end <= anchorIdx) {
        const gap = text.slice(r.end, anchorIdx);
        if (gap.trim() === '' || FILLER_RE.test(gap)) {
          destRoom = r;
          break;
        }
      }
    }
    if (!destRoom) continue;

    let bestName = null;
    for (let i = names.length - 1; i >= 0; i--) {
      if (names[i].start < destRoom.start) {
        bestName = names[i];
        break;
      }
    }
    if (!bestName) continue;

    results.push({ patientName: bestName.name, destRoom: destRoom.raw });
  }

  const seen = new Set();
  return results.filter(r => {
    const key = `${r.patientName}|${r.destRoom}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function handleNursingGroupMessage(event) {
  const userMessage = event.message.text.trim();
  const messageId = event.message.id;
  const transfers = extractTransfers(userMessage);

  if (transfers.length === 0) return; // 전실 안내가 아니면 그냥 무시

  for (const t of transfers) {
    try {
      await fetch(`${transferFirebaseUrl}.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patientName: t.patientName,
          destRoom: t.destRoom,
          rawText: userMessage,
          messageId: messageId,
          timestamp: Date.now(),
          status: 'pending'
        })
      });
    } catch (error) {
      console.error('전실 정보 저장 실패:', error);
    }
  }
}

// ───────────── 기존 시설요청 로직 (그대로) ─────────────

async function handleFacilityGroupEvent(event) {
  if (event.type === 'unsend') {
    const unsentMessageId = event.unsend.messageId;
    try {
      const response = await fetch(`${firebaseUrl}.json`);
      const data = await response.json();
      if (data) {
        const targetKey = Object.keys(data).find(
          key => data[key].messageId === unsentMessageId
        );
        if (targetKey) {
          await fetch(`${firebaseUrl}/${targetKey}.json`, { method: 'DELETE' });
          console.log(`취소된 메시지 삭제 완료: ${targetKey}`);
        } else {
          for (const key of Object.keys(data)) {
            const replies = data[key].replies;
            if (!replies) continue;
            const replyKey = Object.keys(replies).find(
              rk => replies[rk].messageId === unsentMessageId
            );
            if (replyKey) {
              await fetch(`${firebaseUrl}/${key}/replies/${replyKey}.json`, { method: 'DELETE' });
              console.log(`취소된 답장 삭제 완료: ${key}/${replyKey}`);
              break;
            }
          }
        }
      }
    } catch (error) {
      console.error('취소 메시지 삭제 중 오류 발생:', error);
    }
    return;
  }

  if (event.type === 'message' && event.message.type === 'text') {
    const userMessage = event.message.text.trim();
    const messageId = event.message.id;
    const quotedMessageId = event.message.quotedMessageId;

    if (quotedMessageId) {
      try {
        const response = await fetch(`${firebaseUrl}.json`);
        const data = await response.json();
        if (data) {
          let targetKey = Object.keys(data).find(
            key => data[key].messageId === quotedMessageId
          );
          if (!targetKey) {
            targetKey = Object.keys(data).find(key => {
              const replies = data[key].replies;
              if (!replies) return false;
              return Object.values(replies).some(r => r.messageId === quotedMessageId);
            });
          }
          if (targetKey) {
            await fetch(`${firebaseUrl}/${targetKey}/replies.json`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: userMessage,
                timestamp: Date.now(),
                messageId: messageId
              })
            });
            await fetch(`${firebaseUrl}/${targetKey}.json`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                status: 'completed',
                completedAt: Date.now(),
                replyMessage: userMessage
              })
            });
            console.log(`답장 대상 수리요청 완료 처리 완료: ${targetKey}`);
          }
        }
      } catch (error) {
        console.error('답장 완료 처리 중 오류 발생:', error);
      }
    } else {
      try {
        await fetch(`${firebaseUrl}.json`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messageId: messageId,
            text: userMessage,
            timestamp: Date.now(),
            status: 'pending'
          })
        });
      } catch (error) {
        console.error('Firebase 저장 실패:', error);
      }
    }
  }
}

// ───────────── 진입점: 방(groupId)에 따라 분기 ─────────────

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const events = req.body.events || [];

    for (const event of events) {
      const groupId = event.source && event.source.groupId;

      // groupId 확인용 임시 로그 - NURSING_GROUP_ID를 채워넣고 나면 지워도 됩니다.
      if (groupId && groupId !== NURSING_GROUP_ID) {
        console.log('[groupId 확인] 이 이벤트가 온 방의 groupId:', groupId);
      }

      if (NURSING_GROUP_ID && groupId === NURSING_GROUP_ID) {
        if (event.type === 'message' && event.message.type === 'text') {
          await handleNursingGroupMessage(event);
        }
        // 간호팀 방에서는 unsend/답장 처리 로직은 적용하지 않습니다.
        continue;
      }

      // 그 외(=시설요청방 등)는 기존 로직 그대로 처리
      await handleFacilityGroupEvent(event);
    }

    return res.status(200).json({ message: 'OK' });
  }
  res.status(200).send('LINE Webhook Server is Running!');
}
