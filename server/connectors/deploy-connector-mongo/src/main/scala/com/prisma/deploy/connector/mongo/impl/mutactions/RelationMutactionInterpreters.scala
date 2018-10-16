package com.prisma.deploy.connector.mongo.impl.mutactions

import com.prisma.deploy.connector.mongo.database.MongoDeployDatabaseMutationBuilder._
import com.prisma.deploy.connector.mongo.database.NoAction
import com.prisma.deploy.connector.mongo.impl.DeployMongoAction
import com.prisma.deploy.connector.{CreateRelationTable, DeleteRelationTable, RenameRelationTable}
import com.prisma.shared.models.Relation

import scala.concurrent.Future

object CreateRelationInterpreter extends MongoMutactionInterpreter[CreateRelationTable] {
  override def execute(mutaction: CreateRelationTable)  = Indexhelper.add(mutaction.relation)
  override def rollback(mutaction: CreateRelationTable) = Indexhelper.remove(mutaction.relation)
}

object DeleteRelationInterpreter extends MongoMutactionInterpreter[DeleteRelationTable] {
  override def execute(mutaction: DeleteRelationTable)  = NoAction.unit //gets dropped with collection
  override def rollback(mutaction: DeleteRelationTable) = Indexhelper.add(mutaction.relation)
}

object Indexhelper {
  def add(relation: Relation) = DeployMongoAction { database =>
    if (relation.isInlineRelation) {
      relation.modelAField.relationIsInlinedInParent match {
        case true  => addRelationIndex(database, relation.modelAField.model.dbName, relation.modelAField.dbName)
        case false => addRelationIndex(database, relation.modelBField.model.dbName, relation.modelBField.dbName)
      }
    } else {
      Future.successful(())
    }
  }

  def remove(relation: Relation) = DeployMongoAction { database =>
    if (relation.isInlineRelation) {
      relation.modelAField.relationIsInlinedInParent match {
        case true  => removeRelationIndex(database, relation.modelAField.model.dbName, relation.modelAField.dbName)
        case false => removeRelationIndex(database, relation.modelBField.model.dbName, relation.modelBField.dbName)
      }
    } else {
      Future.successful(())
    }
  }
}

//Fixme again: Index Renaming does not work -> see Rename Model
object RenameRelationInterpreter extends MongoMutactionInterpreter[RenameRelationTable] {
  override def execute(mutaction: RenameRelationTable) = NoAction.unit

  override def rollback(mutaction: RenameRelationTable) = NoAction.unit

}
