import Nexmo from 'nexmo'
import { getFormattedPhoneNumber } from '../../../lib/phone-format'
import { Message, r } from '../../models'
import { log } from '../../../lib'

let nexmo = null
if (process.env.NEXMO_API_KEY && process.env.NEXMO_API_SECRET) {
  nexmo = new Nexmo({
    apiKey: process.env.NEXMO_API_KEY,
    apiSecret: process.env.NEXMO_API_SECRET
  })
}

export async function findNewCell() {
  if (!nexmo) {
    return '+18179994303'
  }
  return new Promise((resolve, reject) => {
    nexmo.number.search('US', { features: 'VOICE,SMS', size: 1 }, (err, response) => {
      if (err) {
        reject(err)
      } else {
        resolve(response)
      }
    })
  })
}

export async function rentNewCell() {
  const newCell = await findNewCell()
  if (newCell && newCell.numbers && newCell.numbers[0] && newCell.numbers[0].msisdn) {
    return new Promise((resolve, reject) => {
      nexmo.number.buy('US', newCell.numbers[0].msisdn, (err, response) => {
        if (err) {
          reject(err)
        } else {
          resolve(newCell.numbers[0].msisdn)
        }
      })
    })
  }
  throw new Error('Did not find any cell')
}

export async function sendMessage(message) {
  if (!nexmo) {
    return 'test_message_uuid'
  }

  return new Promise((resolve, reject) => {
    // US numbers require that the + be removed when sending via nexmo
    console.log(message)
    nexmo.message.sendSms(message.user_number.replace(/^\+/, ''),
      message.contact_number,
      message.text, (err, response) => {
        console.log(err, response)
        if (err) {
          reject(err)
        } else {
          const serviceMessageId = response.messages[0]['message-id']
          Message.save({
            ...message,
            service_message_id: serviceMessageId,
            service: 'nexmo'
          }, { conflict: 'update' })
          .then((saveError, newMessage) => {
            resolve(newMessage)
          })
        }
      }
    )
  })
}

export async function handleIncomingMessage(message) {
  if (!message.hasOwnProperty('to') ||
    !message.hasOwnProperty('msisdn') ||
    !message.hasOwnProperty('text') ||
    !message.hasOwnProperty('messageId')) {
    log.error(`This is not an incoming message: ${JSON.stringify(message)}`)
  }
  const { to, msisdn, text, messageId } = message

  const contactNumber = getFormattedPhoneNumber(msisdn)
  const userNumber = getFormattedPhoneNumber(to)

  const lastMessage = await r.table('message')
    .filter({
      contact_number: contactNumber,
      user_number: userNumber,
      is_from_contact: false
    })
    .orderBy(r.desc('created_at'))
    .limit(1)
    .pluck('assignment_id')(0)
    .default(null)

  if (lastMessage) {
    const assignmentId = lastMessage.assignment_id
    const messageInstance = new Message({
      contact_number: contactNumber,
      user_number: userNumber,
      is_from_contact: true,
      text,
      assignment_id: assignmentId,
      service_message_id: messageId,
      service: 'nexmo'
    })

    await messageInstance.save()

    await r.table('campaign_contact')
      .getAll(assignmentId, { index: 'assignment_id' })
      .filter({ cell: contactNumber })
      .limit(1)
      .update({ message_status: 'needsResponse' })

    return messageInstance.id
  }
  throw new Error('No message thread to attach incoming message to')
}
