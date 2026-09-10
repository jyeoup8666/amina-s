export default async function handler(req, res) {
  if (req.method === 'POST') {
    const events = req.body.events || [];
    const firebaseUrl = 'https://facility-check-74a17-default-rtdb.firebaseio.com/facility_requests';

    for (let event of events) {

      // ─────────────────────────────────────────────
      // CASE 0 (신규): 메시지를 보내기 취소(unsend)한 경우
      // - 취소된 게 "원본 요청 메시지"면 요청 자체를 삭제
      // - 취소된 게 "답장"이면 그 답장만 replies 목록에서 삭제
      // ─────────────────────────────────────────────
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
              await fetch(`${firebaseUrl}/${targetKey}.json`, {
                method: 'DELETE'
              });
              console.log(`취소된 메시지 삭제 완료: ${targetKey}`);
            } else {
              // 원본 요청이 아니라면, 답장 중 하나가 취소된 것인지 확인
              for (const key of Object.keys(data)) {
                const replies = data[key].replies;
                if (!replies) continue;
                const replyKey = Object.keys(replies).find(
                  rk => replies[rk].messageId === unsentMessageId
                );
                if (replyKey) {
                  await fetch(`${firebaseUrl}/${key}/replies/${replyKey}.json`, {
                    method: 'DELETE'
                  });
                  console.log(`취소된 답장 삭제 완료: ${key}/${replyKey}`);
                  break;
                }
              }
            }
          }
        } catch (error) {
          console.error('취소 메시지 삭제 중 오류 발생:', error);
        }
        continue; // unsend 이벤트는 아래 message 처리와 무관하므로 다음 이벤트로
      }

      if (event.type === 'message' && event.message.type === 'text') {
        const userMessage = event.message.text.trim();
        const messageId = event.message.id; // 현재 메시지 ID
        const quotedMessageId = event.message.quotedMessageId; // 답장 대상 원본 메시지 ID

        // CASE 1: 특정 메시지에 '답장'을 한 경우 -> 답장 대상 요청을 완료 처리
        if (quotedMessageId) {
          try {
            const response = await fetch(`${firebaseUrl}.json`);
            const data = await response.json();
            if (data) {
              // 1) 원본 요청 메시지에 대한 답장인지 확인
              let targetKey = Object.keys(data).find(
                key => data[key].messageId === quotedMessageId
              );

              // 2) 원본이 아니라면, "이전 답장"에 대한 답장(답장에 답장)인지 확인
              if (!targetKey) {
                targetKey = Object.keys(data).find(key => {
                  const replies = data[key].replies;
                  if (!replies) return false;
                  return Object.values(replies).some(r => r.messageId === quotedMessageId);
                });
              }

              if (targetKey) {
                // 답장을 replies 목록에 "추가" (기존 답장을 덮어쓰지 않고 계속 쌓입니다)
                // 이 답장 자체의 messageId도 함께 저장해서, 나중에 "이 답장"에 또 답장이 달려도 추적할 수 있게 합니다.
                await fetch(`${firebaseUrl}/${targetKey}/replies.json`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    message: userMessage,
                    timestamp: Date.now(),
                    messageId: messageId
                  })
                });

                // status/completedAt/replyMessage도 계속 갱신합니다.
                // (replyMessage는 항상 "가장 최근 답장"을 담고 있으며, 예전 화면과의 호환을 위해 유지합니다.)
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
        }
        // CASE 2: 신규 수리 요청 메시지인 경우 -> DB에 저장
        else {
          try {
            await fetch(`${firebaseUrl}.json`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messageId: messageId, // 답장 추적 및 취소 감지를 위해 LINE 메시지 ID 함께 저장
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
    return res.status(200).json({ message: 'OK' });
  }
  res.status(200).send('LINE Webhook Server is Running!');
}