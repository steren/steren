'use strict';

/* Controllers */

/*
angular.module('portfolio.controllers', []).
	controller('WorkCtrl', [function($scope, Work) {
		$scope.works = Work.query();
		$scope.orderProp = 'date';
		$scope.type = {'code': true, 'graphic':true, 'event':true};
	}]);
*/

/*
http://docs.angularjs.org/guide/dev_guide.mvc.understanding_controller

myApp.controller('GreetingCtrl', ['$scope', function($scope) {
    $scope.greeting = 'Hola!';
}]);
*/

// TODO : use a module and controller() notation
var WorkCtrl = function($scope, Work) {
	$scope.works = Work.query();
	$scope.orderProp = 'date';
	$scope.type = {'code': true, 'graphic':true, 'event':true};
	$scope.participation = {'lead':true, 'contribution':true};
	$scope.seriousness = {'serious':true, 'notsoserious':true};
};
